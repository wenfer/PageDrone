import { flowApi } from './api';
import { evaluateExpression } from './expression';
import { typeMeta } from './flow-model';
import type {
  AbortState,
  CanvasEdge,
  CanvasNode,
  HttpRequestResponse,
  LogLevel,
  Procedure,
  RunMark,
  Site,
  FlowNodeReport,
  FlowErrorType,
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
  /** AI 诊断流程时让技能执行器回传逐步页面观察。 */
  diagnostic?: boolean;
  nodeReports: FlowNodeReport[];
  activeExecutionIds: Set<string>;
  cleanup?: (executionIds?: string[]) => Promise<void>;
  /** 单节点重试时可从指定节点开始，不强制走开始节点。 */
  startNodeId?: string;
}

export interface FlowValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** 执行前轻量校验：阻止确定性坏引用，同时把需要浏览器现场确认的项目列为 warning。 */
export async function validateFlow(context: Pick<ExecutionContext, 'nodes' | 'edges' | 'procedures' | 'sites'>): Promise<FlowValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const start = context.nodes.find((node) => node.type === 'start');
  const end = context.nodes.find((node) => node.type === 'end');
  if (!start) errors.push('缺少开始节点');
  if (!end) errors.push('缺少结束节点');
  if (start && !context.edges.some((edge) => edge.source === start.id)) errors.push('开始节点没有连线');
  if (end && !context.edges.some((edge) => edge.target === end.id)) warnings.push('结束节点没有入线，流程可能无法到达');
  for (const node of context.nodes) {
    if (node.type === 'procedure') {
      const siteId = String(node.data.siteId || '').trim();
      const procedureId = String(node.data.procedureId || '').trim();
      const procedure = context.procedures.find((item) => item.id === procedureId);
      const site = context.sites.find((item) => item.id === siteId);
      if (!siteId) { errors.push(`节点「${nodeLabel(node)}」未选择网站`); continue; }
      if (!site) { errors.push(`节点「${nodeLabel(node)}」引用的站点不存在`); continue; }
      if (!site.enabled) warnings.push(`节点「${nodeLabel(node)}」所属站点“${site.name}”已禁用，运行时将跳过`);
      if (!isValidHttpUrl(site.url)) errors.push(`站点“${site.name}”网址无效：${site.url || '空'}`);
      if (!procedure) { errors.push(`节点「${nodeLabel(node)}」引用的技能不存在（${procedureId || '空'}）`); continue; }
      if (procedure.siteId !== siteId) errors.push(`技能“${procedure.name}”不属于站点“${site.name}”`);
      if (procedure.kind === 'login') errors.push(`节点「${nodeLabel(node)}」不能直接调用登录技能`);
      if (procedure.kind === 'checkin') {
        const selectorStep = procedure.steps?.find((step) => step.type === 'click');
        if (!selectorStep?.selector) warnings.push(`技能“${procedure.name}”没有签到按钮点击选择器，建议打开真实页面检查`);
        else {
          const exists = await probeSelector(site.url, selectorStep.selector);
          if (exists === false) warnings.push(`技能“${procedure.name}”的签到按钮选择器在当前页面未找到：${selectorStep.selector}`);
          if (exists === null) warnings.push(`技能“${procedure.name}”的签到按钮无法完成页面探测，运行时将再次确认：${selectorStep.selector}`);
        }
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(site.url, { method: 'HEAD', signal: controller.signal, credentials: 'include' });
        clearTimeout(timer);
        if (!response.ok) warnings.push(`站点“${site.name}”预检返回 HTTP ${response.status}，请检查服务是否正常`);
      } catch {
        warnings.push(`站点“${site.name}”网址暂时不可访问或禁止探测，运行时将再次尝试`);
      }
    } else if (node.type === 'site') {
      const site = context.sites.find((item) => item.id === String(node.data.siteId || ''));
      if (!site) errors.push(`执行站点节点「${nodeLabel(node)}」未选择有效站点`);
      else if (!site.enabled) warnings.push(`执行站点节点「${nodeLabel(node)}」所属站点“${site.name}”已禁用`);
      else if (!isValidHttpUrl(site.url)) errors.push(`站点“${site.name}”网址无效`);
    } else if (node.type === 'request' || node.type === 'http') {
      if (!isValidHttpUrl(String(node.data.url || '').trim())) errors.push(`请求节点「${nodeLabel(node)}」URL 无效`);
      if (!String(node.data.variable || '').trim()) errors.push(`请求节点「${nodeLabel(node)}」未设置结果变量`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

type BranchResult = boolean | '__stop__' | null;

export async function executeFlow(context: ExecutionContext): Promise<'completed' | 'aborted'> {
  const start = context.startNodeId
    ? context.nodes.find((node) => node.id === context.startNodeId)
    : context.nodes.find((node) => node.type === 'start');
  if (!start) throw new Error('没有开始节点');
  if (!context.startNodeId && !context.edges.some((edge) => edge.source === start.id)) {
    context.log('warn', '开始节点没有连线，请从右侧端口拖出一条连线');
  }
  await walk(context, start.id, new Set());
  return context.abort.aborted ? 'aborted' : 'completed';
}

async function walk(context: ExecutionContext, nodeId: string, visitedEdges: Set<string>): Promise<void> {
  if (context.abort.aborted) return;
  const node = context.nodes.find((item) => item.id === nodeId);
  if (!node) return;

  const nodeName = String(node.data.label || typeMeta(node.type).label);
  const startedAt = Date.now();
  context.markNode(nodeId, 'running');
  context.log('info', `▶ ${nodeName}${node.type === 'procedure' && node.data.procedureId ? ` · procedureId=${node.data.procedureId}` : ''}`);
  await sleep(30, context.abort);
  if (context.abort.aborted) {
    const finishedAt = Date.now();
    context.markNode(nodeId, 'aborted');
    context.nodeReports.push(buildNodeReport(context, node, 'aborted', '流程已停止', startedAt, finishedAt, 0, classifyError(new Error('流程已停止'))));
    return;
  }

  const disabledSite = node.type === 'site'
    ? context.sites.find((site) => site.id === String(node.data.siteId || ''))
    : node.type === 'procedure'
      ? context.sites.find((site) => site.id === String(node.data.siteId || context.procedures.find((item) => item.id === String(node.data.procedureId || ''))?.siteId || ''))
      : undefined;
  if (disabledSite && !disabledSite.enabled) {
    const finishedAt = Date.now();
    context.markNode(nodeId, 'skipped');
    context.nodeReports.push(buildNodeReport(context, node, 'skipped', `站点“${disabledSite.name}”已禁用，已跳过`, startedAt, finishedAt, 0));
    context.log('warn', `跳过禁用站点：${disabledSite.name}`);
    // 继续走下游，禁用站点不应拖垮整条流程。
    const outgoingDisabled = context.edges.filter((edge) => edge.source === nodeId);
    for (const edge of outgoingDisabled) {
      if (context.abort.aborted) return;
      await walk(context, edge.target, visitedEdges);
    }
    return;
  }

  let branch: BranchResult = null;
  let lastError: unknown = null;
  const retryCount = Math.max(0, parseIntValue(node.data.retryCount, 0));
  const retryDelayMs = Math.max(0, parseIntValue(node.data.retryDelayMs, 1000));
  const nodeTimeoutMs = Math.max(1000, parseIntValue(node.data.nodeTimeoutMs, 120000));
  let attempts = 0;
  for (; attempts <= retryCount; attempts += 1) {
    try {
      if (attempts > 0) {
        context.log('warn', `节点 ${nodeName} 第 ${attempts + 1} 次重试（间隔 ${retryDelayMs}ms）`);
        await sleep(retryDelayMs, context.abort);
        if (context.abort.aborted) throw Object.assign(new Error('流程已停止'), { errorType: 'aborted' as FlowErrorType });
      }
      branch = await executeNodeWithTimeout(context, node, nodeTimeoutMs);
      const finishedAt = Date.now();
      context.markNode(nodeId, 'done');
      context.nodeReports.push(buildNodeReport(context, node, 'success', '节点执行成功', startedAt, finishedAt, attempts + 1));
      break;
    } catch (error) {
      lastError = error;
      if (context.abort.aborted) break;
      if (attempts >= retryCount) break;
    }
  }
  if (lastError) {
    const finishedAt = Date.now();
    const classification = classifyError(lastError);
    const message = errorMessage(lastError);
    const mark: RunMark = classification.status === 'timeout' ? 'timeout' : classification.status === 'need_login' ? 'need_login' : context.abort.aborted ? 'aborted' : 'failed';
    context.markNode(nodeId, mark);
    context.nodeReports.push(buildNodeReport(context, node, mark === 'aborted' ? 'aborted' : mark, message, startedAt, finishedAt, attempts + 1, classification, lastError));
    context.log(classification.level, `节点失败：站点=${classification.siteName || '—'} 节点=${nodeName} 耗时=${finishedAt - startedAt}ms 错误类型=${classification.errorType}：${message}${classification.repairHint ? `；修复建议：${classification.repairHint}` : ''}`);
    if (context.abort.aborted) return;
    if (node.data.continueOnError === false) throw lastError;
    context.log('warn', `节点 ${nodeName} 已隔离，继续执行后续节点`);
    branch = null;
  }
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

async function executeNodeWithTimeout(context: ExecutionContext, node: CanvasNode, timeoutMs: number): Promise<BranchResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const executionId = node.type === 'procedure' ? `flow_${node.id}_${Date.now().toString(36)}` : undefined;
  if (executionId) context.activeExecutionIds.add(executionId);
  const operation = executeNode(context, node, executionId);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(Object.assign(new Error(`节点超时（${timeoutMs}ms）`), { errorType: 'timeout' as FlowErrorType }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (executionId) {
      context.activeExecutionIds.delete(executionId);
      if (timedOut || context.abort.aborted) {
        await context.cleanup?.([executionId]);
      }
    }
  }
}

async function executeNode(context: ExecutionContext, node: CanvasNode, executionId?: string): Promise<BranchResult> {
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
      const response = await flowApi.runProcedure(procedure.id, url, context.diagnostic === true, executionId);
      if (response.tabId != null) {
        context.tabId = response.tabId;
        context.log('info', `后续网页节点复用标签页 #${response.tabId}`);
      }
      if (response.observations?.length) {
        for (const observation of response.observations) {
          const changes = observation.changes.length ? `；${observation.changes.join('、')}` : '';
          const text = observation.text.replace(/\s+/g, ' ').trim().slice(0, 500);
          const elements = observation.elements
            .slice(0, 12)
            .map((element) => `${element.tag}${element.text ? `「${element.text}」` : ''} ${element.selector}`)
            .join(' | ');
          context.log(
            observation.phase === 'error' ? 'error' : 'info',
            `页面观察 · 步骤 ${observation.stepIndex >= 0 ? observation.stepIndex + 1 : '打开'} · ${observation.url}${changes}` +
              `${text ? `；正文：${text}` : ''}${elements ? `；可交互：${elements}` : ''}`,
          );
        }
      }
      // 诊断模式下即使被测技能失败，也必须先把已采集的页面事实写入流程报告，
      // 不能因这里抛错而丢掉失败步骤前后的观察快照。
      if (response.failedStepIndex !== undefined) {
        const failedStep = response.failedStepIndex >= 0
          ? `步骤 ${response.failedStepIndex + 1}`
          : '脚本';
        context.log(
          'error',
          `技能失败位置：${failedStep}${response.failedStepType ? `（${response.failedStepType}）` : ''}`,
        );
      }
      if (response.ok === false) {
        throw Object.assign(new Error(response.message || response.error || '技能执行失败'), {
          failedStepIndex: response.failedStepIndex,
          failedStepType: response.failedStepType,
          status: response.status,
        });
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

function ensureResponseOk(response: { ok?: boolean; error?: string; message?: string }, fallback: string): void {
  if (response.ok === false) throw new Error(response.message || response.error || fallback);
}

function responseValue(response: HttpRequestResponse): unknown {
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

interface ErrorClassification {
  errorType: FlowErrorType;
  status: 'failed' | 'timeout' | 'need_login' | 'aborted';
  level: LogLevel;
  repairHint: string;
  siteName?: string;
}

function classifyError(error: unknown): ErrorClassification {
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  const explicit = (error as { errorType?: FlowErrorType } | null)?.errorType;
  if (explicit === 'timeout' || /timeout|超时|deadline/.test(lower)) {
    return { errorType: 'timeout', status: 'timeout', level: 'error', repairHint: '检查页面是否卡顿；必要时提高该节点超时或拆分技能步骤。' };
  }
  if (explicit === 'aborted' || /abort|停止|中止/.test(lower)) {
    return { errorType: 'aborted', status: 'aborted', level: 'warn', repairHint: '节点已停止；可在失败节点上单独重试。' };
  }
  if (/http\s*5\d\d|\b5\d\d\b/.test(lower)) {
    return { errorType: 'http_500', status: 'failed', level: 'error', repairHint: '检查接口服务是否可用、请求方法、请求体和认证配置。' };
  }
  if (/network|fetch failed|failed to fetch|err_connection|网络|连接失败|dns/.test(lower)) {
    return { errorType: 'network', status: 'failed', level: 'error', repairHint: '检查网址、网络连接、扩展 host 权限及跨域配置。' };
  }
  if (/login|登录|未登录|登录态|授权/.test(lower)) {
    return { errorType: 'need_login', status: 'need_login', level: 'warn', repairHint: '打开所属站点完成普通表单登录，确认进入登录后页面，再重试该节点。' };
  }
  if (/selector|选择器|元素|waitfore|找不到|未找到/.test(lower)) {
    return { errorType: 'selector', status: 'failed', level: 'error', repairHint: '打开真实页面重新观察并更新选择器，确认元素在当前标签页可见。' };
  }
  if (/校验|验证|缺少|未设置|不存在/.test(lower)) {
    return { errorType: 'validation', status: 'failed', level: 'error', repairHint: '执行前修正节点的网站、技能、网址和参数配置。' };
  }
  return { errorType: 'unknown', status: 'failed', level: 'error', repairHint: '查看节点前后的页面观察和步骤日志后再调整技能。' };
}

function buildNodeReport(
  context: ExecutionContext,
  node: CanvasNode,
  status: FlowNodeReport['status'],
  message: string,
  startedAt: number,
  finishedAt: number,
  attempts: number,
  classification?: ErrorClassification,
  sourceError?: unknown,
): FlowNodeReport {
  const procedureId = node.type === 'procedure' ? String(node.data.procedureId || '') || undefined : undefined;
  const procedure = procedureId ? context.procedures.find((item) => item.id === procedureId) : undefined;
  const siteId = String(node.data.siteId || procedure?.siteId || '') || undefined;
  const site = siteId ? context.sites.find((item) => item.id === siteId) : undefined;
  const error = classification;
  const report: FlowNodeReport = {
    nodeId: node.id,
    nodeName: String(node.data.label || typeMeta(node.type).label),
    nodeType: node.type,
    siteId,
    siteName: site?.name,
    procedureId,
    status,
    message,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    attempts,
    ...(error ? { errorType: error.errorType, repairHint: error.repairHint } : {}),
  };
  const stepError = sourceError as { failedStepIndex?: number; failedStepType?: string } | undefined;
  if (stepError?.failedStepIndex !== undefined) report.failedStepIndex = stepError.failedStepIndex;
  if (stepError?.failedStepType) report.failedStepType = stepError.failedStepType;
  return report;
}

function parseIntValue(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nodeLabel(node: CanvasNode): string {
  return String(node.data.label || typeMeta(node.type).label);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function probeSelector(url: string, selector: string): Promise<boolean | null> {
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id ?? undefined;
    if (tabId == null) return null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const current = await chrome.tabs.get(tabId);
      if (current.status === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const result = await chrome.scripting.executeScript({ target: { tabId }, func: (value: string) => {
      try {
        const xpath = /^(xpath\s*:|\/\/|\.\/\/|\/html\b|\/body\b)/i.test(value.trim());
        if (xpath) return Boolean(document.evaluate(value.replace(/^xpath\s*:/i, ''), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue);
        return Boolean(document.querySelector(value.replace(/^css\s*:/i, '')));
      } catch { return false; }
    }, args: [selector] });
    return Boolean(result[0]?.result);
  } catch {
    return null;
  } finally {
    if (tabId != null) await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}
