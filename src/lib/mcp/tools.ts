/**
 * MCP 工具执行层：权限分级、确认门禁、域名白名单与审计，然后复用现有业务内核。
 * 禁止旁路业务逻辑直写 storage：read/write 组复用 agent-skills 的 executeSkill，
 * exec 组复用 enqueueSites / runProcedureStandalone / runFlowTest，browser 组复用
 * src/lib/page/* 注入函数。
 */

import { CancellationToken } from '../cancellation.js';
import type { SkillContext } from '../agent-skills.js';
import { executeSkill } from '../agent-skills.js';
import { createProcedure } from '../models.js';
import { getFlows } from '../flows.js';
import {
  getLogs,
  getProcedure,
  getProcedures,
  getRuntime,
  getSites,
  getSettings,
  upsertProcedure,
} from '../storage.js';
import { isQueueRunning, enqueueSites } from '../execution-queue.js';
import { runFlowTest } from '../flow-test.js';
import { runProcedureStandalone } from '../run-context.js';
import { exploreAndGenerate } from '../explorer.js';
import { performHttpRequest } from '../http-request.js';
import {
  appendMcpAudit,
} from './audit.js';
import { getMcpConfig, type McpAuthMode } from './config.js';
import { McpToolError, mapErrorToMcp } from './errors.js';
import { isDomainRemembered, isWriteRemembered, requestMcpConfirm } from './confirms.js';
import {
  abortMcpExecution,
  createMcpExecution,
  finishMcpExecution,
  getMcpExecution,
  mapRunState,
  registerFlowToken,
  updateMcpExecution,
  waitMcpExecution,
} from './executions.js';
import { MCP_TOOL_BY_NAME, groupsForMode, type McpToolGroup } from './protocol.js';
import {
  mcpClick,
  mcpCloseTab,
  mcpExtract,
  mcpNavigate,
  mcpReadPage,
  mcpWait,
  mcpWaitForText,
  mcpWaitForUrl,
  mcpType,
  assertSafeHttpUrl,
} from './browser.js';

/** 与 executeSkill 对齐的 read/write 工具名（其余工具在下方各自实现） */
const READ_VIA_SKILLS = new Set([
  'list-sites',
  'get-site',
  'list-procedures',
  'get-procedure',
  'list-flows',
  'get-flow',
  'list-logs',
]);
const WRITE_VIA_SKILLS = new Set([
  'create-site',
  'update-site',
  'create-procedure',
  'add-step',
  'update-step',
  'remove-step',
  'replace-steps',
  'update-procedure',
  'set-detect',
  'set-output',
  'create-flow',
  'update-flow-node',
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * browser 组入口域名校验：黑名单硬拒；不属于任何已配置站点且不在白名单的
 * 新域名需用户在扩展 UI 上确认「允许 MCP 操作 example.com」。
 */
async function assertBrowserDomainAllowed(rawUrl: string): Promise<void> {
  const parsed = assertSafeHttpUrl(rawUrl);
  const cfg = await getMcpConfig();
  const host = parsed.hostname.toLowerCase();
  const domain = host.replace(/^www\./, '');
  for (const blocked of cfg.blockedDomains) {
    if (domain === blocked || domain.endsWith(`.${blocked}`)) {
      throw new McpToolError('DOMAIN_NOT_ALLOWED', `域名 ${domain} 在 MCP 黑名单中，已拒绝操作`);
    }
  }
  const sites = await getSites();
  const siteHosts = new Set(sites.map((site) => hostnameOf(site.url)).filter(Boolean));
  if (siteHosts.has(domain)) return;
  if (cfg.allowedDomains.includes(domain) || isDomainRemembered(domain)) return;
  const approved = await requestMcpConfirm({
    kind: 'domain',
    target: domain,
    summary: `外部 MCP 客户端请求操作未配置站点的新域名：${host}`,
  });
  if (!approved) {
    throw new McpToolError('DOMAIN_NOT_ALLOWED', `域名 ${host} 未获得用户授权，可在设置页加入白名单后重试`);
  }
}

/** 权限分级：模式决定可用组；standard 模式 write 组逐次弹窗确认 */
async function enforceGroupPermission(group: McpToolGroup, name: string, mode: McpAuthMode): Promise<void> {
  const allowedGroups = groupsForMode(mode);
  if (!allowedGroups.includes(group)) {
    throw new McpToolError(
      'TOOL_DISABLED_BY_MODE',
      `当前授权模式为 ${mode}，不允许调用 ${group} 组工具 "${name}"。请在扩展设置页调整 MCP 授权模式`,
    );
  }
}

async function maybeConfirmWrite(name: string, mode: McpAuthMode): Promise<void> {
  if (mode !== 'standard' || isWriteRemembered(name)) return;
  const approved = await requestMcpConfirm({
    kind: 'write',
    target: name,
    summary: `外部 MCP 客户端请求执行写入工具：${name}`,
  });
  if (!approved) {
    throw new McpToolError('CONFIRM_DENIED', `写入工具 "${name}" 被用户拒绝或确认超时`);
  }
}

async function skillContext(): Promise<SkillContext> {
  const [procedures, sites, flows, settings] = await Promise.all([
    getProcedures(),
    getSites(),
    getFlows(),
    getSettings(),
  ]);
  return { procedures, sites, flows, settings, signal: new CancellationToken() };
}

async function runViaSkills(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await executeSkill(name, args, await skillContext());
  if (!result.ok) {
    throw new McpToolError(
      /不存在/.test(result.error || '') ? 'NOT_FOUND' : 'VALIDATION_FAILED',
      result.error || '工具执行失败',
      /不存在/.test(result.error || '') ? false : true,
    );
  }
  return (result.data ?? {}) as Record<string, unknown>;
}

// —— exec 组实现 ——

/** 监控全局队列直到空闲，把运行态同步进作业记录 */
async function monitorQueueJob(executionId: string): Promise<void> {
  try {
    await sleep(800);
    await updateMcpExecution(executionId, { state: 'running' });
    let lastMessage = '';
    while (true) {
      const runtime = await getRuntime();
      const mapped = mapRunState(runtime.state);
      if (mapped === 'done') break;
      await updateMcpExecution(executionId, { state: mapped }, runtime.message !== lastMessage ? runtime.message : undefined);
      lastMessage = runtime.message;
      await sleep(1500);
    }
    const logs = await getLogs();
    const success = logs.filter((log) => log.status === 'success').length;
    await finishMcpExecution(executionId, {
      ok: true,
      status: 'done',
      message: '队列执行结束',
      recentLogs: logs.slice(0, 10).map((log) => ({
        siteName: log.siteName,
        status: log.status,
        message: log.message,
        finishedAt: log.finishedAt,
      })),
      successCountHint: success,
    });
  } catch (e) {
    await finishMcpExecution(
      executionId,
      { ok: false, status: 'failed' },
      { errorCode: mapErrorToMcp(e).code, message: mapErrorToMcp(e).message },
    );
  }
}

async function execRunAll(): Promise<Record<string, unknown>> {
  const ids = (await getSites()).filter((site) => site.enabled).map((site) => site.id);
  if (!ids.length) throw new McpToolError('NOT_FOUND', '没有已启用的站点');
  enqueueSites(ids, { reason: 'manual' });
  const executionId = await createMcpExecution('run-all', `全部站点（${ids.length} 个）`);
  void monitorQueueJob(executionId);
  return { executionId, accepted: true, queued: ids.length };
}

async function execRunSite(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const siteId = String(args.siteId || '');
  const site = (await getSites()).find((item) => item.id === siteId);
  if (!site) throw new McpToolError('NOT_FOUND', `站点 ${siteId} 不存在，请先用 list-sites 获取真实 id`);
  enqueueSites([siteId], { reason: args.force === true ? 'manual-force' : 'manual' });
  const executionId = await createMcpExecution('run-site', site.name);
  void monitorQueueJob(executionId);
  return { executionId, accepted: true, siteId };
}

async function execRunProcedure(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const procedureId = String(args.procedureId || '');
  const proc = await getProcedure(procedureId);
  if (!proc) throw new McpToolError('NOT_FOUND', `技能 ${procedureId} 不存在，请先用 list-procedures 获取真实 id`);
  if (proc.kind === 'login') {
    throw new McpToolError('VALIDATION_FAILED', '登录技能不能独立运行，请通过 run-site 或流程执行');
  }
  if (typeof args.siteId === 'string' && args.siteId.trim() && args.siteId !== proc.siteId) {
    throw new McpToolError('VALIDATION_FAILED', `技能「${proc.name}」归属于站点 ${proc.siteId}，与传入 siteId 不一致`);
  }
  const executionId = await createMcpExecution('run-procedure', proc.name);
  void (async () => {
    try {
      await updateMcpExecution(executionId, { state: 'running' });
      const outcome = await runProcedureStandalone(procedureId, {
        url: typeof args.url === 'string' && args.url.trim() ? args.url : undefined,
        keepTab: false,
        active: true,
        withSiteLogin: true,
        executionId,
        onObservation: (observation) => {
          void updateMcpExecution(
            executionId,
            {},
            `步骤 ${observation.stepIndex >= 0 ? observation.stepIndex + 1 : '打开'} ${observation.phase}：${observation.url.slice(0, 120)}`,
          );
        },
      });
      const errorCode = outcome.status === 'need_login'
        ? 'LOGIN_REQUIRED' as const
        : outcome.status === 'cf_timeout'
          ? 'CF_CHALLENGE' as const
          : undefined;
      await finishMcpExecution(
        executionId,
        {
          ok: outcome.ok,
          status: outcome.status,
          message: outcome.message,
          outputs: outcome.outputs ?? null,
          returnValue: outcome.returnValue ?? null,
          tabId: outcome.tabId ?? null,
        },
        { errorCode },
      );
    } catch (e) {
      const mapped = mapErrorToMcp(e);
      await finishMcpExecution(executionId, { ok: false, status: 'failed' }, { errorCode: mapped.code, message: mapped.message });
    }
  })();
  return { executionId, accepted: true, procedureId };
}

async function execRunFlow(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const flowId = String(args.flowId || '');
  const flow = (await getFlows()).find((item) => item.id === flowId);
  if (!flow) throw new McpToolError('NOT_FOUND', `流程 ${flowId} 不存在，请先用 list-flows 获取真实 id`);
  const executionId = await createMcpExecution('run-flow', flow.name);
  const token = new CancellationToken();
  registerFlowToken(executionId, token);
  void (async () => {
    try {
      await updateMcpExecution(executionId, { state: 'running' }, `开始执行流程「${flow.name}」`);
      const report = await runFlowTest(flowId, token, (message) => {
        void updateMcpExecution(executionId, {}, message.slice(0, 200));
      });
      await finishMcpExecution(executionId, {
        ok: report.ok,
        status: report.status,
        message: report.message,
        nodeReports: report.nodeReports,
        summary: report.summary ?? null,
        variables: report.variables,
      }, { errorCode: report.ok ? undefined : 'INTERNAL' });
    } catch (e) {
      const mapped = mapErrorToMcp(e);
      await finishMcpExecution(executionId, { ok: false, status: 'failed' }, { errorCode: mapped.code, message: mapped.message });
    }
  })();
  return { executionId, accepted: true, flowId };
}

async function execGetExecution(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const executionId = String(args.executionId || '');
  const record = await waitMcpExecution(executionId, Number(args.waitMs) || 0);
  if (!record) throw new McpToolError('NOT_FOUND', `executionId ${executionId} 不存在`);
  return record as unknown as Record<string, unknown>;
}

async function execAbortExecution(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const executionId = String(args.executionId || '');
  const record = await getMcpExecution(executionId);
  if (!record) throw new McpToolError('NOT_FOUND', `executionId ${executionId} 不存在`);
  return abortMcpExecution(executionId);
}

// —— browser 组高阶工具：探索生成技能（异步作业） ——

async function browserExplore(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = String(args.url || '');
  const siteId = String(args.siteId || '');
  const goal = String(args.goal || '');
  if (!/^https?:\/\//i.test(url)) throw new McpToolError('VALIDATION_FAILED', 'url 必须是 http(s) 地址');
  const site = (await getSites()).find((item) => item.id === siteId);
  if (!site) throw new McpToolError('NOT_FOUND', `siteId ${siteId} 不存在，请先用 list-sites 获取真实 id`);
  const settings = await getSettings();
  if (!settings.llmApiKey) {
    throw new McpToolError('AUTH_FAILED', '未配置大模型 API Key，请先在扩展设置页填写 AI 设置');
  }
  const keywords = Array.isArray(args.successKeywords) ? args.successKeywords.map(String).filter(Boolean) : [];
  const executionId = await createMcpExecution('explore', goal.slice(0, 60) || 'MCP 探索生成技能');
  void (async () => {
    try {
      await updateMcpExecution(executionId, { state: 'running' }, '开始 AI 探索');
      const result = await exploreAndGenerate(url, goal, keywords, settings, (progress) => {
        if (progress.message) void updateMcpExecution(executionId, {}, progress.message.slice(0, 200));
      });
      if (!result.ok) {
        await finishMcpExecution(
          executionId,
          { ok: false, message: result.message, steps: result.steps.length },
          { message: `${result.message}（已归纳 ${result.steps.length} 个步骤，未保存）` },
        );
        return;
      }
      const outputFields = result.steps
        .map((step, index) => (step.type === 'extract' ? step.variable || `step_${index + 1}` : ''))
        .filter(Boolean);
      const draft = createProcedure({
        siteId,
        kind: 'checkin',
        name: goal.slice(0, 40) || 'MCP 探索生成技能',
        description: `由 MCP 客户端探索生成（${url}）`,
        url,
        steps: result.steps,
        script: '',
        detect: { successKeywords: keywords, failKeywords: [] },
        output: { enabled: outputFields.length > 0, fields: outputFields },
        explorationHistory: [
          {
            id: result.explorationId,
            url,
            goal,
            llmProvider: settings.llmProvider,
            llmModel: settings.llmModel,
            stepsGenerated: result.steps.length,
            at: Date.now(),
          },
        ],
      });
      const saved = await upsertProcedure(draft);
      await finishMcpExecution(executionId, {
        ok: true,
        procedureId: saved.id,
        siteId,
        stepCount: saved.steps.length,
        message: result.message,
      });
    } catch (e) {
      const mapped = mapErrorToMcp(e);
      await finishMcpExecution(executionId, { ok: false }, { errorCode: mapped.code, message: mapped.message });
    }
  })();
  return { executionId, accepted: true };
}

// —— 分发 ——

async function dispatch(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (READ_VIA_SKILLS.has(name)) return runViaSkills(name, args);
  if (WRITE_VIA_SKILLS.has(name)) return runViaSkills(name, args);

  switch (name) {
    case 'get-status': {
      const runtime = await getRuntime();
      return {
        runtime: {
          state: runtime.state,
          message: runtime.message,
          currentSiteName: runtime.currentSiteName,
          queueLength: Array.isArray(runtime.queue) ? runtime.queue.length : 0,
        },
        queueRunning: isQueueRunning(),
      };
    }
    case 'run-all':
      return execRunAll();
    case 'run-site':
      return execRunSite(args);
    case 'run-procedure':
      return execRunProcedure(args);
    case 'run-flow':
      return execRunFlow(args);
    case 'get-execution':
      return execGetExecution(args);
    case 'abort-execution':
      return execAbortExecution(args);
    case 'http-request':
      return performHttpRequest({
        url: String(args.url || ''),
        method: typeof args.method === 'string' ? args.method : 'GET',
        headers: (args.headers as Record<string, string> | undefined) ?? undefined,
        body: args.body,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      });
    case 'navigate': {
      await assertBrowserDomainAllowed(String(args.url || ''));
      return mcpNavigate({
        url: String(args.url || ''),
        tabMode: args.tabMode === 'managed-reuse' ? 'managed-reuse' : 'managed-new',
      });
    }
    case 'read-page':
      return mcpReadPage({
        includeElements: args.includeElements !== false,
        textMaxLength: typeof args.textMaxLength === 'number' ? args.textMaxLength : undefined,
        elementLimit: typeof args.elementLimit === 'number' ? args.elementLimit : undefined,
      });
    case 'click':
      return mcpClick({
        selector: String(args.selector || ''),
        watchPopup: args.watchPopup !== false,
        followPopup: args.followPopup === true,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      });
    case 'type':
      return mcpType({
        selector: String(args.selector || ''),
        text: String(args.text ?? ''),
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      });
    case 'wait':
      return mcpWait(Number(args.ms) || 0);
    case 'wait-for-text':
      return mcpWaitForText({
        selector: typeof args.selector === 'string' ? args.selector : undefined,
        includes: String(args.includes ?? ''),
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      });
    case 'wait-for-url':
      return mcpWaitForUrl({
        match: String(args.match || ''),
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      });
    case 'extract':
      return mcpExtract({
        selector: String(args.selector || ''),
        mode: typeof args.mode === 'string' ? (args.mode as 'text') : undefined,
        attribute: typeof args.attribute === 'string' ? args.attribute : undefined,
        multiple: args.multiple !== false,
      });
    case 'close-tab':
      return mcpCloseTab();
    case 'explore-and-create-procedure':
      await assertBrowserDomainAllowed(String(args.url || ''));
      return browserExplore(args);
    default:
      throw new McpToolError('VALIDATION_FAILED', `工具 "${name}" 未实现`);
  }
}

/**
 * MCP tools/call 总入口：开关 → 工具存在性 → 模式分组 → write 确认 → 域名门禁
 * （navigate/explore 内部执行）→ 执行 → 审计。任何异常都映射为规范错误码。
 */
export async function handleMcpToolCall(
  name: string,
  args: Record<string, unknown>,
  client: string,
): Promise<Record<string, unknown>> {
  const def = MCP_TOOL_BY_NAME.get(name);
  const auditBase = { tool: name, group: def?.group ?? 'unknown', client };
  if (!def) {
    await appendMcpAudit({ ...auditBase, summary: args, status: 'denied', code: 'VALIDATION_FAILED', message: `未知工具 ${name}` });
    throw new McpToolError('VALIDATION_FAILED', `未知工具 "${name}"，可通过 tools/list 查看全部可用工具`);
  }
  const cfg = await getMcpConfig();
  if (!cfg.enabled) {
    await appendMcpAudit({ ...auditBase, summary: args, status: 'denied', code: 'AUTH_FAILED', message: 'MCP 服务未开启' });
    throw new McpToolError('AUTH_FAILED', 'MCP 服务未开启，请在扩展设置页开启后再连接');
  }
  try {
    await enforceGroupPermission(def.group, name, cfg.mode);
    if (def.group === 'write') await maybeConfirmWrite(name, cfg.mode);
    const data = await dispatch(name, args);
    await appendMcpAudit({ ...auditBase, summary: args, status: 'ok' });
    return data;
  } catch (e) {
    const mapped = mapErrorToMcp(e);
    const denied =
      mapped.code === 'TOOL_DISABLED_BY_MODE' ||
      mapped.code === 'DOMAIN_NOT_ALLOWED' ||
      mapped.code === 'CONFIRM_DENIED' ||
      mapped.code === 'AUTH_FAILED';
    await appendMcpAudit({
      ...auditBase,
      summary: args,
      status: denied ? 'denied' : 'error',
      code: mapped.code,
      message: mapped.message,
    });
    throw e;
  }
}
