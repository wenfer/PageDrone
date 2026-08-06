import { flowApi } from './api';
import { evaluateExpression } from './expression';
import { typeMeta } from './flow-model';
import type {
  AbortState,
  CanvasEdge,
  CanvasNode,
  ExtractPageDataResponse,
  HttpRequestResponse,
  LogLevel,
  Procedure,
  RunMark,
  Site,
} from './types';

export interface ExecutionContext {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  procedures: Procedure[];
  sites: Site[];
  /** 目标网页标签页；未指定时由 flowApi 从当前窗口推导并缓存。 */
  tabId?: number;
  variables: Record<string, unknown>;
  abort: AbortState;
  log: (level: LogLevel, message: string) => void;
  markNode: (id: string, mark: RunMark) => void;
  variablesChanged: (variables: Record<string, unknown>) => void;
}

type BranchResult = boolean | '__stop__' | null;

export async function executeFlow(context: ExecutionContext): Promise<'completed' | 'aborted'> {
  const start = context.nodes.find((node) => node.type === 'start');
  if (!start) throw new Error('没有开始节点');
  if (!context.edges.some((edge) => edge.source === start.id)) {
    context.log('warn', '开始节点没有连线，请从右侧端口拖出一条连线');
  }
  await walk(context, start.id, new Set());
  return context.abort.aborted ? 'aborted' : 'completed';
}

async function walk(context: ExecutionContext, nodeId: string, visitedEdges: Set<string>): Promise<void> {
  if (context.abort.aborted) return;
  const node = context.nodes.find((item) => item.id === nodeId);
  if (!node) return;

  context.markNode(nodeId, 'running');
  context.log('info', `▶ ${typeMeta(node.type).label}${node.data.label ? ` · ${node.data.label}` : ''}`);
  await sleep(30, context.abort);

  let branch: BranchResult;
  try {
    branch = await executeNode(context, node);
  } catch (error) {
    context.markNode(nodeId, 'failed');
    throw error;
  }
  context.markNode(nodeId, 'done');
  if (branch === '__stop__' || context.abort.aborted) return;

  let outgoing = context.edges.filter((edge) => edge.source === nodeId);
  if (node.type === 'condition') {
    const wanted = branch === false ? 'false' : 'true';
    const matching = outgoing.filter((edge) => edge.data?.when === wanted);
    outgoing = matching.length > 0
      ? matching
      : outgoing.filter((edge) => !edge.data?.when || edge.data.when === 'always');
  }

  if (node.type === 'parallel') {
    await Promise.all(outgoing.map((edge) => walk(context, edge.target, new Set(visitedEdges))));
    return;
  }

  for (const edge of outgoing) {
    if (context.abort.aborted) return;
    if (visitedEdges.has(edge.id) && node.type !== 'loop') continue;
    visitedEdges.add(edge.id);
    await walk(context, edge.target, visitedEdges);
  }
}

async function executeNode(context: ExecutionContext, node: CanvasNode): Promise<BranchResult> {
  const data = node.data;
  switch (node.type) {
    case 'start':
    case 'end':
    case 'parallel':
      return null;
    case 'delay': {
      const ms = Number.parseInt(interpolate(data.ms ?? 1000, context.variables), 10) || 1000;
      context.log('info', `等待 ${ms}ms`);
      await sleep(ms, context.abort);
      return context.abort.aborted ? '__stop__' : null;
    }
    case 'variable': {
      if (data.name) {
        context.variables[data.name] = interpolate(data.value ?? '', context.variables);
        context.log('info', `变量 ${data.name} = ${String(context.variables[data.name])}`);
        context.variablesChanged({ ...context.variables });
      }
      return null;
    }
    case 'log':
      context.log(data.level ?? 'info', interpolate(data.message ?? '', context.variables));
      return null;
    case 'extract': {
      const selector = interpolate(data.selector ?? '', context.variables).trim();
      if (!selector) throw new Error('提取数据节点未设置 CSS 选择器');
      const variable = String(data.variable ?? '').trim();
      if (!variable) throw new Error('提取数据节点未设置写入变量名');
      const tabId = await getExecutionTabId(context);
      const mode = data.mode ?? 'text';
      const attribute = interpolate(data.attribute ?? '', context.variables).trim();
      if (mode === 'attribute' && !attribute) throw new Error('属性提取模式需要填写属性名');
      context.log('info', `提取数据：${selector}（${mode}${data.multiple ? '，全部匹配' : ''}）`);
      const response = await flowApi.extractPageData(tabId, selector, mode, attribute, Boolean(data.multiple));
      ensureResponseOk(response, '提取数据失败');
      const value = responseValue(response);
      context.variables[variable] = value;
      context.variablesChanged({ ...context.variables });
      context.log('success', `提取结果已写入变量 ${variable}：${summarizeValue(value)}`);
      return null;
    }
    case 'request':
    case 'http': {
      const url = interpolate(data.url ?? '', context.variables).trim();
      if (!url) throw new Error('发送请求节点未设置 URL');
      const variable = String(data.variable ?? '').trim();
      if (!variable) throw new Error('发送请求节点未设置写入变量名');
      const method = String(data.method ?? 'GET').toUpperCase();
      const headers = interpolate(data.headers ?? '', context.variables);
      const body = interpolate(data.body ?? '', context.variables);
      const timeoutMs = Number.parseInt(interpolate(data.timeoutMs ?? 30000, context.variables), 10) || 30000;
      context.log('info', `发送请求：${method} ${url}`);
      const response = await flowApi.httpRequest(url, method, headers, body, timeoutMs);
      ensureResponseOk(response, '请求失败');
      const value = responseValue(response);
      context.variables[variable] = value;
      context.variablesChanged({ ...context.variables });
      const status = response.status != null ? `（HTTP ${response.status}）` : '';
      context.log('success', `请求结果${status}已写入变量 ${variable}：${summarizeValue(value)}`);
      return null;
    }
    case 'condition': {
      let result = false;
      try {
        result = Boolean(evaluateExpression(String(data.expr || 'false'), context.variables));
      } catch (error) {
        context.log('error', `条件表达式错误：${errorMessage(error)}`);
      }
      context.log('info', `条件 = ${result}`);
      return result;
    }
    case 'loop': {
      const count = Number.parseInt(interpolate(data.count ?? 1, context.variables), 10) || 1;
      const loopVar = data.loopVar || 'i';
      const outgoing = context.edges.filter((edge) => edge.source === node.id);
      const bodyEdge = outgoing[0];
      const restEdges = outgoing.slice(1);
      context.log('info', `循环 ${count} 次`);
      if (bodyEdge) {
        for (let index = 0; index < count; index += 1) {
          if (context.abort.aborted) return '__stop__';
          context.variables[loopVar] = index;
          context.variablesChanged({ ...context.variables });
          context.log('info', `-- 第 ${index + 1}/${count} 次 --`);
          await walk(context, bodyEdge.target, new Set());
        }
      }
      for (const edge of restEdges) await walk(context, edge.target, new Set());
      return '__stop__';
    }
    case 'procedure': {
      if (!data.procedureId) throw new Error('未选择技能');
      const procedure = context.procedures.find((item) => item.id === data.procedureId);
      if (!procedure) throw new Error('技能不存在（可能已被删除）');
      const siteId = String(data.siteId || procedure.siteId || '').trim();
      if (!siteId) throw new Error('技能节点未选择网站，请先选择网站');
      const site = context.sites.find((item) => item.id === siteId);
      if (!site) throw new Error('技能所属网站不存在（可能已被删除）');
      if (procedure.siteId !== siteId) throw new Error('技能不属于当前网站，请重新选择技能');
      if (procedure.kind === 'login') throw new Error('登录技能不能独立运行，请改用“执行站点”');
      const explicitUrl = interpolate(data.url ?? '', context.variables).trim();
      const url = explicitUrl || site.url || deriveProcedureUrl(procedure.id, context.procedures, context.sites);
      context.log('info', `调用技能：${procedure.name}（${procedure.steps?.length ?? 0} 个步骤）${url ? ` → ${url}` : ''}`);
      if (data.params && typeof data.params === 'object') {
        const mapped = Object.fromEntries(Object.entries(data.params).map(([key, value]) => [key, interpolate(value, context.variables)]));
        if (Object.keys(mapped).length > 0) context.log('info', `参数：${JSON.stringify(mapped)}`);
      }
      const response = await flowApi.runProcedure(procedure.id, url);
      if (response.ok === false) throw new Error(response.message || response.error || '技能执行失败');
      if (response.tabId != null) {
        context.tabId = response.tabId;
        context.log('info', `后续网页节点复用标签页 #${response.tabId}`);
      }
      if (response.outputs && typeof response.outputs === 'object') {
        const resultVariable = String(data.resultVariable || '').trim();
        if (resultVariable) {
          context.variables[resultVariable] = response.returnValue ?? response.outputs;
          context.log('success', `技能返回值已写入变量 ${resultVariable}`);
        } else {
          Object.assign(context.variables, response.outputs);
          context.log('success', `技能返回字段已合并：${Object.keys(response.outputs).join('、')}`);
        }
        context.variablesChanged({ ...context.variables });
      }
      context.log('success', `技能结果：${response.message || '成功'}`);
      return null;
    }
    case 'site': {
      if (!data.siteId) throw new Error('未选择站点');
      const site = context.sites.find((item) => item.id === data.siteId);
      if (!site) throw new Error('站点不存在');
      context.log('info', `派发执行站点：${site.name}`);
      const response = await flowApi.runSite(site.id, Boolean(data.force));
      if (response.ok === false) throw new Error(response.message || response.error || '站点入队失败');
      context.log('info', `已入队：${response.queued ?? 1} 个`);
      return null;
    }
    default:
      return null;
  }
}

export function deriveProcedureUrl(procedureId: string, procedures: Procedure[], sites: Site[]): string {
  const procedure = procedures.find((item) => item.id === procedureId);
  const goto = procedure?.steps?.find((step) =>
    (step.type === 'goto' || step.type === 'waitForUrl') && Boolean(step.url || step.selector),
  );
  const stepUrl = String(goto?.url || goto?.selector || '').trim();
  if (stepUrl) return stepUrl;
  const owner = procedure?.siteId ? sites.find((site) => site.id === procedure.siteId) : undefined;
  if (owner?.url) return owner.url;
  return sites.find((site) => (
    site.checkinProcedureId === procedureId || site.verificationProcedureId === procedureId
  ) && site.url)?.url ?? '';
}

function interpolate(value: unknown, variables: Record<string, unknown>): string {
  if (value == null) return '';
  const source = typeof value === 'string'
    ? value
    : typeof value === 'object'
      ? (() => { try { return JSON.stringify(value); } catch { return String(value); } })()
      : String(value);
  return source.replace(/\$\{([^}]+)\}/g, (_match, expression: string) => {
    try {
      const resolved = evaluateExpression(expression, variables);
      if (resolved == null) return '';
      if (typeof resolved === 'object') {
        try { return JSON.stringify(resolved); } catch { return String(resolved); }
      }
      return String(resolved);
    } catch {
      return '';
    }
  });
}

async function sleep(ms: number, abort: AbortState): Promise<void> {
  const deadline = Date.now() + Math.max(0, ms);
  while (!abort.aborted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getExecutionTabId(context: ExecutionContext): Promise<number> {
  if (context.tabId != null) return context.tabId;
  const tabId = await flowApi.getExecutionTabId();
  context.tabId = tabId;
  context.log('info', `使用网页标签页 #${tabId} 执行提取`);
  return tabId;
}

function ensureResponseOk(response: { ok?: boolean; error?: string; message?: string }, fallback: string): void {
  if (response.ok === false) throw new Error(response.message || response.error || fallback);
}

function responseValue(response: ExtractPageDataResponse | HttpRequestResponse): unknown {
  if ('data' in response && response.data !== undefined) return response.data;
  if ('value' in response && response.value !== undefined) return response.value;
  if ('body' in response && response.body !== undefined) return response.body;
  if ('result' in response && response.result !== undefined) return response.result;
  return response.message ?? null;
}

function summarizeValue(value: unknown): string {
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  try {
    const json = JSON.stringify(value);
    return json.length > 160 ? `${json.slice(0, 160)}…` : json;
  } catch {
    return String(value);
  }
}
