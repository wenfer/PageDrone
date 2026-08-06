import type { RunState, MSG } from './messaging.js';
import type {
  Procedure,
  Site,
  Settings,
  Flow,
  Log,
  Task,
  Step,
  RunStatus,
  SiteRunResult,
  ExtractMode,
} from './models.js';

/** 运行时状态（setRuntime 增量合并；含探索/录制/介入等临时字段） */
export interface RuntimeState {
  state: RunState;
  currentSiteId: string | null;
  currentSiteName: string | null;
  queue: string[];
  message: string;
  updatedAt: number;
  // 探索
  explorationProgress?: ExploreProgress | null;
  explorationResult?: { ok: boolean; siteId?: string; procId?: string; message?: string; steps?: number } | null;
  // 录制
  recordingSteps?: RecordingPreview[];
  recordingResult?: { ok: boolean; steps: number; reason: string; pending?: boolean };
  // 介入
  interventionCtx?: InterventionContext;
  // AI 对话
  agentProgress?: { sessionId: string; runId: string; turn?: number; message: string; at: number } | null;
  agentResult?: { sessionId: string; runId: string; ok: boolean; halt: string; message: string } | null;
  [key: string]: unknown;
}

export interface RecordingPreview {
  index: number;
  type: string;
  label: string;
}

export type ExploreProgressStage = 'opening' | 'observing' | 'thinking' | 'decision' | 'executing' | 'response' | 'complete' | 'error';
export type ExploreProgressStatus = 'running' | 'info' | 'success' | 'warning' | 'error';

export interface ExploreActionTrace {
  name: string;
  label: string;
  args: Record<string, string>;
  reason?: string;
}

/** 浏览器执行操作后返回的事实；与 AI 的操作决策分开保存，避免把意图当成结果。 */
export interface ExploreActionResponse {
  ok: boolean;
  confirmed: boolean;
  message: string;
  evidence?: unknown;
  openedNewTab?: boolean;
  openedTabId?: number;
  observation?: {
    urlBefore: string;
    urlAfter: string;
    urlChanged: boolean;
    titleChanged: boolean;
    textChanged: boolean;
    interactiveElementsChanged: boolean;
    changed: boolean;
  };
}

export interface ExploreProgressEvent {
  id: string;
  step: number;
  stage: ExploreProgressStage;
  status: ExploreProgressStatus;
  title: string;
  message?: string;
  action?: ExploreActionTrace;
  response?: ExploreActionResponse;
  url?: string;
  at: number;
}

export interface ExploreProgress {
  explorationId: string;
  step: number;
  total: number;
  stage: ExploreProgressStage;
  message: string;
  action?: string;
  reason?: string;
  url?: string;
  events: ExploreProgressEvent[];
  at: number;
}

// —— AI 对话 ——

/** 一次 AI 工具调用在对话流里的可核验结果。 */
export interface SkillTrace {
  skill: string;
  args: Record<string, unknown>;
  thought: string;
  ok: boolean;
  summary: string;
}

export interface ChatTurn {
  id: string;
  role: 'user' | 'agent';
  text: string;
  at: number;
  status?: 'success' | 'question' | 'error';
  traces?: SkillTrace[];
  touched?: { kind: 'procedure' | 'site' | 'flow'; id: string; name: string }[];
}

export type AgentChatSessionStatus = 'idle' | 'running' | 'interrupted';

/** 持久化到 chrome.storage.local 的完整会话。 */
export interface AgentChatSessionRecord {
  id: string;
  title: string;
  turns: ChatTurn[];
  status: AgentChatSessionStatus;
  activeRunId?: string;
  createdAt: number;
  updatedAt: number;
}

/** 会话历史侧栏使用的轻量摘要。 */
export interface AgentChatSessionSummary {
  id: string;
  title: string;
  preview: string;
  turnCount: number;
  status: AgentChatSessionStatus;
  createdAt: number;
  updatedAt: number;
}

// —— 步骤执行结果 ——

export interface ExecutionResult {
  ok: boolean;
  message: string;
  loginRedirect?: boolean;
  needKeywordCheck: boolean;
  cfWaitedMs?: number;
  /** 技能内 extract/script 步骤产生的命名结果。 */
  outputs?: Record<string, unknown>;
  returnValue?: unknown;
}

// —— 偏差介入 ——

export type InterventionAction = 'retry' | 'skip' | 'patch' | 'abort';

export interface InterventionDecision {
  action: InterventionAction;
  patchStep?: Step;
}

export interface InterventionContext {
  token: string;
  procId: string;
  stepIndex: number;
  step: Step;
  error: string;
  tabId: number;
}

export interface RunProcedureOptions {
  url?: string;
  keepTab?: boolean;
  active?: boolean;
  watchDeviation?: boolean;
}

export interface ExtractPageDataOptions {
  /** 未提供时由后台使用当前活动标签页；流程节点应传入技能运行返回的 tabId。 */
  tabId?: number;
  selector: string;
  mode?: ExtractMode;
  attribute?: string;
  multiple?: boolean;
}

export interface HttpRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  /** 可传对象，也兼容节点编辑器中的 JSON/Key: Value 文本。 */
  headers?: Record<string, string> | string;
  /** 字符串或可 JSON 序列化对象；GET/HEAD 会忽略 body。 */
  body?: unknown;
  timeoutMs?: number;
}

/** RunContext.run() 的执行结果（站点执行与独立技能运行共用） */
export interface RunOutcome {
  status: RunStatus;
  message: string;
  startedAt: number;
  finishedAt: number;
  cfWaitedMs: number;
  tabId?: number | null;
  outputs?: Record<string, unknown>;
  returnValue?: unknown;
}

export interface KeywordJudgement {
  status: RunStatus;
  message: string;
}

// —— 消息请求联合（供 SW switch 收窄）———

export interface MessageRequestMap {
  [MSG.PING]: Record<string, never>;
  [MSG.GET_STATUS]: Record<string, never>;
  [MSG.RUN_ALL]: { siteIds?: string[] };
  [MSG.RUN_SITE]: { siteId: string; force?: boolean };
  [MSG.RESCHEDULE]: Record<string, never>;
  [MSG.STOP]: { reason?: string };
  [MSG.PROCEDURE_LIST]: Record<string, never>;
  [MSG.PROCEDURE_SAVE]: { procedure: Procedure };
  [MSG.PROCEDURE_DELETE]: { id: string };
  [MSG.RUN_PROCEDURE]: { procedureId: string } & RunProcedureOptions;
  [MSG.MARKET_INDEX]: Record<string, never>;
  [MSG.MARKET_INSTALL]: { marketId: string; siteId: string };
  [MSG.FLOW_LIST]: Record<string, never>;
  [MSG.FLOW_SAVE]: { flow: Flow };
  [MSG.FLOW_DELETE]: { id: string };
  [MSG.EXTRACT_PAGE_DATA]: ExtractPageDataOptions;
  [MSG.HTTP_REQUEST]: HttpRequestOptions;
  [MSG.EXPLORE_GENERATE]: { siteId: string; url: string; goal: string; successKws?: string[] };
  [MSG.EXPLORE_ABORT]: Record<string, never>;
  // —— AI 设置：连通性测试与模型列表 ——
  [MSG.LLM_TEST]: { prompt?: string };
  [MSG.LLM_MODELS]: {
    /** 获取模型时允许使用设置页尚未保存的表单草稿，不隐式持久化 API Key。 */
    config?: {
      provider?: Settings['llmProvider'];
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      headers?: string;
    };
  };
  // —— AI 对话 ——
  [MSG.AGENT_CHAT_SEND]: { sessionId: string; text: string };
  [MSG.AGENT_CHAT_ABORT]: { sessionId: string };
  [MSG.AGENT_CHAT_RESET]: { sessionId: string };
  [MSG.AGENT_CHAT_HISTORY]: { sessionId?: string };
  [MSG.AGENT_CHAT_CREATE]: Record<string, never>;
  [MSG.AGENT_CHAT_DELETE]: { sessionId: string };
  // 前端（options.js）发的是打平字段，不是嵌套 decision 对象
  [MSG.INTERVENTION_RESOLVE]: { token: string; action?: InterventionAction; patchStep?: Step | null };
  [MSG.RECORD_START]: { url: string };
  [MSG.RECORD_STOP]: { siteId: string; url?: string; name?: string; successKws?: string[] };
  [MSG.RECORD_EVENT]: { event: RecordingEvent };
  [MSG.RECORD_STEP_REMOVE]: { index: number };
  [MSG.RECORD_DISCARD]: Record<string, never>;
}

export type MessageRequest = {
  [K in keyof MessageRequestMap]: { type: K } & MessageRequestMap[K];
}[keyof MessageRequestMap];

/** 采集器回流的页面事件 */
export type RecordingEvent =
  | { type: 'click'; selector: string; label?: string; navigates?: boolean }
  | { type: 'type'; selector: string; value: string; masked?: boolean };

export interface StatusResponse {
  runtime: RuntimeState;
  sites: Site[];
  settings: Settings;
  procedures: Procedure[];
}

// 重新导出常用类型，方便各模块单一导入
export type {
  Procedure,
  Site,
  Settings,
  Flow,
  Log,
  Task,
  Step,
  SiteRunResult,
};
