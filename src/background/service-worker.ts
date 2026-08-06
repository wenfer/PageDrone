/**
 * Background Service Worker — 调度中枢
 */

import { MSG, RUN_STATE } from '../lib/messaging.js';
import {
  getRuntime,
  getSites,
  getSettings,
  setRuntime,
  getProcedures,
  upsertProcedure,
  removeProcedure,
} from '../lib/storage.js';
import { enqueueSites, isQueueRunning, stopQueue } from '../lib/execution-queue.js';
import { rescheduleAllAlarms, handleAlarm, updateBadgeFromLogs } from '../lib/scheduler.js';
import { runProcedureStandalone, resolveIntervention } from '../lib/run-context.js';
import { runMigrations } from '../lib/migrate.js';
import { fetchMarketIndex, installFromMarket } from '../lib/market.js';
import { getFlows, saveFlow, deleteFlow } from '../lib/flows.js';
import { exploreAndGenerate, abortExploration } from '../lib/explorer.js';
import {
  startAgentMessage,
  abortAgent,
  resetAgentSession,
  getAgentHistory,
  createAgentSession,
  deleteAgentSession,
} from '../lib/agent-chat.js';
import { LlmClient } from '../lib/llm.js';
import {
  startRecording,
  stopRecording,
  discardRecording,
  handleRecordEvent,
  removeRecordedStep,
  isRecording,
} from '../lib/recorder.js';
import { createProcedure } from '../lib/models.js';
import type { MessageRequest, Settings, Step } from '../lib/types.js';
import { pageExtractData, type PageExtractOptions, type PageExtractResult } from '../lib/page/extract.js';

/** handleMessage 的返回值统一被展开进 { ok: true, ... } 响应体 */
type MessageResult = Record<string, unknown>;

/** 用全局设置构造 LLM 客户端（AI 设置的测试/模型列表与探索引擎共用同一份配置） */
function llmClientFromSettings(settings: Settings): LlmClient {
  return new LlmClient({
    provider: settings.llmProvider || 'anthropic',
    apiKey: settings.llmApiKey || '',
    baseUrl: settings.llmBaseUrl,
    model: settings.llmModel,
    headers: settings.llmHeaders,
  });
}

async function bootstrap(): Promise<void> {
  await runMigrations();
  await setRuntime({ state: RUN_STATE.IDLE, message: '已就绪', queue: [] });
  await rescheduleAllAlarms();
  await updateBadgeFromLogs();
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await bootstrap();
  if (details.reason === 'install') {
    try {
      await chrome.runtime.openOptionsPage();
    } catch {
      /* ignore */
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  // 浏览器重启后内存队列已空，复位运行态
  await bootstrap();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void handleAlarm(alarm);
});

// 点击工具栏图标直接进入管理页（无 popup）；已打开则聚焦复用，避免开一堆重复标签
chrome.action.onClicked.addListener(async () => {
  const optionsUrl = chrome.runtime.getURL('options.html');
  try {
    const tabs = await chrome.tabs.query({ url: `${optionsUrl}*` });
    const tab = tabs[0];
    if (tab) {
      if (tab.id != null) await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  } catch {
    /* 查询失败则退回新建 */
  }
  await chrome.tabs.create({ url: optionsUrl });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.sites || changes.procedures) {
    void rescheduleAllAlarms();
  }
});

function errText(err: unknown): string {
  return (err as Error)?.message || String(err);
}

/** Resolve a page tab for a data-extraction node. */
async function resolveExtractionTab(tabId?: number): Promise<number> {
  if (Number.isInteger(tabId) && (tabId as number) > 0) {
    try {
      const tab = await chrome.tabs.get(tabId as number);
      if (tab.id == null) throw new Error('目标标签页不存在');
      return tab.id;
    } catch {
      throw new Error('目标标签页已关闭，请先执行打开页面或技能节点');
    }
  }
  const active = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (active?.id == null) throw new Error('没有可用的活动标签页');
  return active.id;
}

/**
 * Execute an outbound request in the service worker. Keeping this here gives
 * flow nodes the same host-permission/CORS behaviour as the rest of the SW.
 */
async function performHttpRequest(options: {
  url: string;
  method?: string;
  headers?: Record<string, string> | string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const url = String(options.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('请求 URL 必须是 http(s) 地址');
  const method = String(options.method || 'GET').toUpperCase();
  const allowed = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
  if (!allowed.has(method)) throw new Error(`不支持的请求方法：${method}`);

  const timeoutMs = Math.min(120000, Math.max(1000, Number(options.timeoutMs) || 30000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    let rawHeaders: Record<string, string> = {};
    if (typeof options.headers === 'string' && options.headers.trim()) {
      try {
        const parsed = JSON.parse(options.headers);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          rawHeaders = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value ?? '')]));
        }
      } catch {
        for (const line of options.headers.split(/\r?\n/)) {
          const index = line.indexOf(':');
          if (index > 0) rawHeaders[line.slice(0, index).trim()] = line.slice(index + 1).trim();
        }
      }
    } else if (options.headers && typeof options.headers === 'object') {
      rawHeaders = options.headers;
    }
    for (const [key, value] of Object.entries(rawHeaders)) {
      const name = String(key || '').trim();
      if (!name) continue;
      headers[name] = String(value ?? '');
    }

    let body: BodyInit | undefined;
    if (method !== 'GET' && method !== 'HEAD' && options.body !== undefined && options.body !== null) {
      if (typeof options.body === 'string') {
        body = options.body;
      } else {
        body = JSON.stringify(options.body);
        if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

    const response = await fetch(url, {
      method,
      headers,
      body,
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
    });
    const raw = await response.text();
    const contentType = response.headers.get('content-type') || '';
    let data: unknown = raw;
    if (/json/i.test(contentType) && raw.trim()) {
      try { data = JSON.parse(raw); } catch { /* keep raw response */ }
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      data,
      url: response.url || url,
      message: response.ok ? `请求成功（${response.status}）` : `请求失败（HTTP ${response.status}）`,
    };
  } catch (error) {
    if ((error as DOMException)?.name === 'AbortError') {
      throw new Error(`请求超时（${timeoutMs}ms）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const msg = (message ?? {}) as MessageRequest;
  const type = msg.type;
  // STOP 优先处理：队列跑满时 handleMessage 可能排在后面，停止指令不该排队
  if (type === MSG.STOP) {
    Promise.resolve()
      .then(() => stopQueue(msg.reason || '用户强制停止'))
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err: unknown) => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  // 录制事件来自注入页面的采集器，需要 sender.tab.id 判定来源标签；同步处理，不走 handleMessage
  if (type === MSG.RECORD_EVENT) {
    try {
      const r = handleRecordEvent(msg.event, _sender?.tab?.id);
      // 与旧实现一致：r.ok 覆盖默认的 ok:true
      sendResponse({ ok: true, ...(r as Record<string, unknown>) });
    } catch (err) {
      sendResponse({ ok: false, error: errText(err) });
    }
    return true;
  }

  handleMessage(msg)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err: unknown) => sendResponse({ ok: false, error: errText(err) }));
  return true;
});

async function handleMessage(message: MessageRequest): Promise<MessageResult> {
  switch (message.type) {
    case MSG.PING:
      return { pong: true, running: isQueueRunning() };

    case MSG.GET_STATUS: {
      const [runtime, sites, settings, procedures] = await Promise.all([
        getRuntime(),
        getSites(),
        getSettings(),
        getProcedures(),
      ]);
      return { runtime, sites, settings, procedures, queueRunning: isQueueRunning() };
    }

    case MSG.RUN_ALL: {
      const sites = await getSites();
      const ids = sites.filter((s) => s.enabled).map((s) => s.id);
      if (!ids.length) throw new Error('没有已启用的站点');
      enqueueSites(ids, { reason: 'manual' });
      return { queued: ids.length };
    }

    case MSG.RUN_SITE: {
      const siteId = message.siteId;
      if (!siteId) throw new Error('缺少 siteId');
      enqueueSites([siteId], {
        reason: message.force ? 'manual-force' : 'manual',
      });
      return { queued: 1, siteId };
    }

    case MSG.RESCHEDULE: {
      await rescheduleAllAlarms();
      return { rescheduled: true };
    }

    case MSG.STOP: {
      return stopQueue(message.reason || '用户强制停止');
    }

    // —— Procedures ——
    case MSG.PROCEDURE_LIST: {
      const procedures = await getProcedures();
      return { procedures };
    }
    case MSG.PROCEDURE_SAVE: {
      if (!message.procedure) throw new Error('缺少 procedure');
      const saved = await upsertProcedure(message.procedure);
      await rescheduleAllAlarms();
      return { procedure: saved };
    }
    case MSG.PROCEDURE_DELETE: {
      if (!message.id) throw new Error('缺少 id');
      await removeProcedure(message.id);
      return { deleted: true };
    }
    case MSG.RUN_PROCEDURE: {
      if (!message.procedureId) throw new Error('缺少 procedureId');
      // 独立标签页执行技能（画布「调用技能」节点使用）
      const result = await runProcedureStandalone(message.procedureId, {
        url: message.url || '',
        keepTab: !!message.keepTab,
        active: message.active !== false,
        watchDeviation: !!message.watchDeviation,
      });
      return { ...result };
    }

    // —— Market ——
    case MSG.MARKET_INDEX: {
      const index = await fetchMarketIndex();
      return { index };
    }
    case MSG.MARKET_INSTALL: {
      if (!message.marketId) throw new Error('缺少 marketId');
      if (!message.siteId) throw new Error('请先选择网站');
      const result = await installFromMarket(message.marketId, message.siteId);
      return result;
    }

    // —— Canvas Flows ——
    case MSG.FLOW_LIST: {
      const flows = await getFlows();
      return { flows };
    }
    case MSG.FLOW_SAVE: {
      if (!message.flow) throw new Error('缺少 flow');
      const saved = await saveFlow(message.flow);
      return { flow: saved };
    }
    case MSG.FLOW_DELETE: {
      if (!message.id) throw new Error('缺少 id');
      await deleteFlow(message.id);
      return { deleted: true };
    }

    // —— 流程数据采集与接口请求 ——
    case MSG.EXTRACT_PAGE_DATA: {
      const selector = String(message.selector || '').trim();
      if (!selector) throw new Error('缺少提取选择器');
      const tabId = await resolveExtractionTab(message.tabId);
      const tab = await chrome.tabs.get(tabId);
      const pageUrl = tab.url || tab.pendingUrl || '';
      if (!/^https?:\/\//i.test(pageUrl)) {
        throw new Error('当前页面不支持注入提取（请先打开 http(s) 页面）');
      }
      const options: PageExtractOptions = {
        selector,
        mode: message.mode,
        attribute: message.attribute,
        multiple: message.multiple,
      };
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageExtractData,
        args: [options],
      });
      const extracted = (result[0]?.result || {
        ok: false,
        count: 0,
        message: '页面没有返回提取结果',
      }) as PageExtractResult;
      return { ...extracted, tabId, pageUrl };
    }

    case MSG.HTTP_REQUEST: {
      return await performHttpRequest({
        url: message.url,
        method: message.method,
        headers: message.headers,
        body: message.body,
        timeoutMs: message.timeoutMs,
      });
    }

    // —— AI 探索生成技能（归纳期）——
    case MSG.EXPLORE_GENERATE: {
      const siteId = String(message.siteId || '').trim();
      const url = String(message.url || '').trim();
      const goal = String(message.goal || '').trim();
      const successKws = Array.isArray(message.successKws) ? message.successKws : [];
      if (!siteId || !url || !goal) throw new Error('缺少所属网站、目标网址或目标描述');
      if (!(await getSites()).some((site) => site.id === siteId)) throw new Error('所属网站不存在，请刷新后重试');
      const settings = await getSettings();
      if (!settings.llmApiKey) {
        throw new Error('未配置大模型 API Key，请到「全局设置 → AI 设置」填写');
      }
      // 异步启动，不阻塞；前端通过 GET_STATUS 轮询 runtime.explorationProgress
      await setRuntime({ explorationProgress: null, explorationResult: null });
      let progressWrites = Promise.resolve();
      exploreAndGenerate(url, goal, successKws, settings, (progress) => {
        // 串行落盘，确保快速连续的“决策 → 执行 → 浏览器响应”不会乱序覆盖。
        progressWrites = progressWrites.then(() => setRuntime({ explorationProgress: progress })).then(() => undefined);
      })
        .then(async (result) => {
          await progressWrites;
          if (result.ok) {
            const outputFields = result.steps
              .map((step, index) => (step.type === 'extract' ? step.variable || `step_${index + 1}` : ''))
              .filter(Boolean);
            const draft = createProcedure({
              siteId,
              kind: 'checkin',
              name: goal.slice(0, 40) || 'AI 探索生成技能',
              description: `由 AI 探索生成（${url}）`,
              url,
              steps: result.steps,
              // 探索归纳出的结果必须以标准步骤执行；脚本仅是用户主动选择的高级兜底。
              script: '',
              detect: {
                successKeywords: successKws,
                failKeywords: [],
              },
              // 探索包含提取动作时自动开启返回契约；普通点击/输入技能仍不暴露页面数据。
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
            await upsertProcedure(draft);
            await setRuntime({
              state: RUN_STATE.IDLE,
              message: '探索完成',
              explorationResult: {
                ok: true,
                siteId,
                procId: draft.id,
                message: result.message,
                steps: result.steps.length,
              },
            });
          } else {
            await setRuntime({
              state: RUN_STATE.IDLE,
              message: '探索结束',
              explorationResult: { ok: false, message: result.message, steps: result.steps.length },
            });
          }
        })
        .catch(async (e: unknown) => {
          await progressWrites;
          await setRuntime({
            state: RUN_STATE.IDLE,
            message: '探索失败',
            explorationResult: { ok: false, message: errText(e) },
          });
        });
      return { started: true };
    }

    case MSG.EXPLORE_ABORT: {
      abortExploration();
      return { aborted: true };
    }

    // —— AI 设置：连通性测试与模型列表 ——
    // 都走 SW 而非选项页直连：SW 有 host_permissions，不受选项页 CORS 限制，
    // 且与探索引擎共用同一套 LlmClient，测通即代表探索能跑通。
    case MSG.LLM_TEST: {
      const settings = await getSettings();
      const result = await llmClientFromSettings(settings).test(message.prompt);
      return { ...result };
    }
    case MSG.LLM_MODELS: {
      const settings = await getSettings();
      const draft = message.config;
      const client = draft
        ? new LlmClient({
            provider: draft.provider ?? settings.llmProvider ?? 'anthropic',
            apiKey: draft.apiKey ?? settings.llmApiKey ?? '',
            baseUrl: draft.baseUrl ?? settings.llmBaseUrl,
            model: draft.model ?? settings.llmModel,
            headers: draft.headers ?? settings.llmHeaders,
          })
        : llmClientFromSettings(settings);
      const models = await client.listModels();
      return { models };
    }

    // —— AI 对话 ——
    // 与 EXPLORE_GENERATE 同样异步启动：一轮对话可能跑几十秒（多轮 LLM + 可能开标签），
    // 同步等会撞上 SW 的消息响应超时。前端轮询 runtime.agentProgress 看进度，
    // 完成后用 AGENT_CHAT_HISTORY 取完整对话。
    case MSG.AGENT_CHAT_SEND: {
      const text = String(message.text || '').trim();
      if (!text) throw new Error('消息内容为空');
      await setRuntime({ agentResult: null });
      const run = await startAgentMessage(text, message.sessionId);
      run.completion
        .then(async (reply) => {
          await setRuntime({
            agentResult: {
              sessionId: run.sessionId,
              runId: run.runId,
              ok: reply.ok,
              halt: reply.halt,
              message: reply.text,
            },
          });
        })
        .catch(async (e: unknown) => {
          await setRuntime({
            agentResult: {
              sessionId: run.sessionId,
              runId: run.runId,
              ok: false,
              halt: 'error',
              message: errText(e),
            },
          });
        });
      return { started: true, sessionId: run.sessionId, runId: run.runId };
    }
    case MSG.AGENT_CHAT_ABORT: {
      return { aborted: abortAgent(message.sessionId) };
    }
    case MSG.AGENT_CHAT_RESET: {
      const session = await resetAgentSession(message.sessionId);
      await setRuntime({ agentProgress: null, agentResult: null });
      return { reset: true, session };
    }
    case MSG.AGENT_CHAT_HISTORY: {
      return { ...(await getAgentHistory(message.sessionId)) };
    }
    case MSG.AGENT_CHAT_CREATE: {
      return { session: await createAgentSession() };
    }
    case MSG.AGENT_CHAT_DELETE: {
      await deleteAgentSession(message.sessionId);
      return { deleted: true };
    }

    // —— 执行时偏差介入（自愈期）——
    case MSG.INTERVENTION_RESOLVE: {
      if (!message.token) throw new Error('缺少 token');
      const r = resolveIntervention(message.token, {
        action: message.action || 'abort',
        patchStep: message.patchStep || undefined,
      });
      return r;
    }

    // —— 录制生成技能（人工示范期）——
    case MSG.RECORD_START: {
      const url = String(message.url || '').trim();
      if (!url) throw new Error('缺少目标网址');
      if (isRecording()) throw new Error('已有录制进行中，请先停止');
      await setRuntime({ recordingResult: null });
      const r = await startRecording(url);
      return r;
    }

    case MSG.RECORD_STOP: {
      const siteId = String(message.siteId || '').trim();
      if (!siteId) throw new Error('缺少所属网站');
      if (!(await getSites()).some((site) => site.id === siteId)) throw new Error('所属网站不存在，请刷新后重试');
      const r = stopRecording();
      if (r.ok && r.steps.length) {
        const url = String(message.url || '').trim();
        const name = String(message.name || '').trim() || '录制生成技能';
        const successKws = Array.isArray(message.successKws) ? message.successKws : [];
        const draft = createProcedure({
          siteId,
          kind: 'checkin',
          name: name.slice(0, 40),
          description: `由用户录制生成${url ? `（${url}）` : ''}`,
          url,
          steps: r.steps as unknown as Step[],
          detect: { successKeywords: successKws, failKeywords: [] },
        });
        await upsertProcedure(draft);
        await setRuntime({ recordingResult: { ok: true, procId: draft.id, steps: r.steps.length } });
        return { ok: true, procId: draft.id, steps: r.steps.length };
      }
      return { ok: false, steps: 0, message: r.message || '未录制到任何步骤' };
    }

    case MSG.RECORD_STEP_REMOVE: {
      const r = removeRecordedStep(Number(message.index));
      return r;
    }

    case MSG.RECORD_DISCARD: {
      const r = discardRecording();
      await setRuntime({
        state: RUN_STATE.IDLE,
        message: '已放弃录制',
        recordingSteps: [],
        recordingResult: null,
      });
      return r;
    }

    default: {
      const unknownType = (message as { type?: string }).type;
      throw new Error(`未知消息类型: ${unknownType}`);
    }
  }
}
