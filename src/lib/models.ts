/** 默认配置、实体类型与工厂方法 */

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 页面提取操作的通用返回形态。列表/表格模式始终返回数组。 */
export type ExtractMode = 'text' | 'attribute' | 'html' | 'value' | 'list' | 'table';

// —— 步骤（Step）：按 type 判别的联合 ——

interface StepBase {
  type: string;
  timeoutMs?: number;
}

export interface WaitStep extends StepBase {
  type: 'wait';
  ms: number;
}
export interface WaitForStep extends StepBase {
  type: 'waitFor';
  selector: string;
}
export interface WaitForTextStep extends StepBase {
  type: 'waitForText';
  selector: string;
  includes: string;
}
export interface TypeStep extends StepBase {
  type: 'type';
  selector: string;
  text: string;
}
export interface GotoStep extends StepBase {
  type: 'goto';
  url: string;
  /** 兼容旧数据：早期版本用 selector 字段装载跳转 URL */
  selector?: string;
}
export interface WaitForUrlStep extends StepBase {
  type: 'waitForUrl';
  /** 正则或子串（/regex/flags 格式为正则，否则子串包含） */
  match: string;
  /** 兼容旧数据：selector / includes / url 字段的 fallback */
  selector?: string;
  includes?: string;
  url?: string;
}
export interface ManualStep extends StepBase {
  type: 'manual';
  message: string;
  match: string;
  selector?: string;
  /** 兼容旧数据：match 的 fallback 字段 */
  includes?: string;
  url?: string;
}
/** 技能内的原子数据提取操作，和 click/type 等操作同级。 */
export interface ExtractStep extends StepBase {
  type: 'extract';
  selector: string;
  mode: ExtractMode;
  attribute?: string;
  multiple?: boolean;
  /** 技能内结果名；留空时执行器使用 step_N。 */
  variable?: string;
  /** 找不到元素时是否让技能失败；默认 true。 */
  required?: boolean;
}
export interface ClickStep extends StepBase {
  type: 'click';
  selector: string;
  waitNavigation: boolean;
  /** 点击后等待新建标签页；通常由 AI 探索自动生成。 */
  watchPopup?: boolean;
  /** 接管新标签页并在其中继续后续步骤，而不是停留在原标签页。 */
  followPopup?: boolean;
  returnMatch?: string;
  /** 兼容旧数据：returnMatch 的 fallback 字段 */
  match?: string;
  includes?: string;
  navTimeoutMs?: number;
  popupTimeoutMs?: number;
}

export type Step =
  | WaitStep
  | WaitForStep
  | WaitForTextStep
  | TypeStep
  | GotoStep
  | WaitForUrlStep
  | ManualStep
  | ExtractStep
  | ClickStep;

export type StepType = Step['type'];

// —— 技能（Procedure，保留内部名称与存储键以兼容历史数据）——

export interface LoginDetect {
  loggedInSelector: string;
  loggedInUrlIncludes: string;
  loginUrlPattern: string;
  notLoggedInKeywords: string[];
}

export interface CheckinDetect {
  successKeywords: string[];
  failKeywords: string[];
  /** 可选：执行步骤中命中此 URL 模式时也判定为掉线去登录 */
  loginUrlPattern?: string;
}

export interface VerificationDetect {
  /** 验证完成后应出现的元素；留空时依赖通用防护页检测。 */
  completedSelector: string;
  /** 验证完成后 URL 应包含的片段；留空时依赖通用防护页检测。 */
  completedUrlIncludes: string;
}

export type Detect = LoginDetect | CheckinDetect | VerificationDetect;

export interface ExplorationRecord {
  id: string;
  url: string;
  goal: string;
  llmProvider?: string;
  llmModel?: string;
  stepsGenerated: number;
  at: number;
}

/** 技能的返回契约；fields 为空表示返回全部 extract/script 结果。 */
export interface ProcedureOutputSpec {
  enabled: boolean;
  fields: string[];
}

export interface PatchRecord {
  id: string;
  stepIndex: number;
  before: unknown;
  after: unknown;
  trigger: 'human' | 'llm';
  reason: string;
  at: number;
}

interface ProcedureBase {
  id: string;
  /** 所属网站。产品层是一对多关系：一个网站拥有多个技能。 */
  siteId: string;
  kind: 'login' | 'checkin' | 'verification';
  name: string;
  description: string;
  /** 生成来源页面网址（AI 探索 / 录制生成时写入，执行期仅作参考） */
  url?: string;
  detect: Detect;
  steps: Step[];
  script: string;
  source: 'local' | 'market';
  author: string;
  homepage: string;
  version: string;
  marketId: string;
  installedAt: number;
  updatedAt: number;
  createdAt: number;
  lastResult: SiteRunResult | null;
  explorationHistory: ExplorationRecord[];
  patchHistory: PatchRecord[];
  /** 技能是否作为有返回值的原子操作对外暴露结果。 */
  output: ProcedureOutputSpec;
}

export interface LoginProcedure extends ProcedureBase {
  kind: 'login';
  detect: LoginDetect;
  /** 登录步骤总超时（ms），缺省 180000 */
  timeoutMs?: number;
}

export interface CheckinProcedure extends ProcedureBase {
  kind: 'checkin';
  detect: CheckinDetect;
}

export interface VerificationProcedure extends ProcedureBase {
  kind: 'verification';
  detect: VerificationDetect;
  /** 验证技能总超时（ms），缺省 180000。 */
  timeoutMs?: number;
}

export type ExecutableProcedure = CheckinProcedure | VerificationProcedure;
export type Procedure = LoginProcedure | ExecutableProcedure;

// —— 站点（Site）——

export type SiteMode = 'steps' | 'script';

export interface Schedule {
  enabled: boolean;
  type: 'daily';
  hour: number;
  minute: number;
}

export type RunStatus =
  | 'success'
  | 'failed'
  | 'cf_timeout'
  | 'need_login'
  | 'skipped'
  | 'running'
  | 'waiting_cf';

export interface LastResult {
  status: RunStatus;
  message: string;
  at: number;
  cfWaitedMs?: number;
}

export interface SiteRunResult extends LastResult {}

export interface Site {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  mode: SiteMode;
  /** 默认自动化技能；网站可拥有更多技能，流程节点可按 siteId 选择任意子技能。 */
  checkinProcedureId: string;
  loginProcedureId: string | null;
  verificationProcedureId: string | null;
  cfTimeoutMs: number;
  pageLoadTimeoutMs: number;
  stepsTimeoutMs: number;
  keepTabOnError: boolean;
  openInBackground: boolean;
  schedule: Schedule;
  lastResult: LastResult | null;
  createdAt: number;
  updatedAt: number;
}

// —— 日志与执行批次归档 ——

export type TaskTrigger = 'manual' | 'schedule' | 'single';
export type TaskState = 'running' | 'done' | 'aborted';

export interface Log {
  id: string;
  taskId: string;
  siteId: string;
  siteName: string;
  status: RunStatus;
  message: string;
  startedAt: number;
  finishedAt: number;
  cfWaitedMs: number;
}

export interface Task {
  id: string;
  trigger: TaskTrigger;
  state: TaskState;
  startedAt: number;
  finishedAt: number;
  total: number;
  success: number;
  failed: number;
  skipped: number;
}

// —— 设置 ——

export type LlmProvider = 'anthropic' | 'openai';

export interface Settings {
  notifyOnComplete: boolean;
  notifyOnError: boolean;
  openInBackground: boolean;
  siteGapMs: number;
  defaultCfTimeoutMs: number;
  defaultPageLoadTimeoutMs: number;
  cfManualGraceMs: number;
  maxLogs: number;
  marketUrl: string;
  llmProvider: LlmProvider;
  llmModel: string;
  llmApiKey: string;
  llmBaseUrl: string;
  /** 自定义请求头，`Key: Value` 多行文本；同名覆盖默认头，值留空表示删除该默认头 */
  llmHeaders: string;
  agentMaxSteps: number;
  agentTimeoutMs: number;
}

// —— 流程（Flow）——

export interface FlowNode {
  id: string;
  type: string;
  x: number;
  y: number;
  data?: Record<string, unknown>;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  when?: string;
}

export interface Flow {
  id: string;
  name: string;
  description: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  variables: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// —— 工厂方法 ——

export function defaultSettings(): Settings {
  return {
    notifyOnComplete: true,
    notifyOnError: true,
    openInBackground: true,
    siteGapMs: 2000,
    defaultCfTimeoutMs: 90000,
    defaultPageLoadTimeoutMs: 45000,
    cfManualGraceMs: 120000,
    maxLogs: 200,
    marketUrl: 'https://cdn.jsdelivr.net/gh/wenfer/auto-checkin-procedures@main/index.json',
    // —— AI 设置（探索引擎与设置页测试共用）——
    llmProvider: 'anthropic',
    llmModel: 'claude-3-5-sonnet-20241022',
    llmApiKey: '', // 用户填入自己的 key，仅本地存储，不上传第三方
    llmBaseUrl: '', // 留空使用官方 endpoint
    llmHeaders: '', // 留空使用默认请求头
    agentMaxSteps: 15,
    agentTimeoutMs: 300000,
  };
}

export function defaultSchedule(): Schedule {
  return { enabled: false, type: 'daily', hour: 8, minute: 5 };
}

/** 默认两步操作步骤（点击执行 → 等待成功文案） */
export function defaultCheckinSteps(): Step[] {
  return [
    { type: 'click', selector: '.checkin', timeoutMs: 15000, waitNavigation: true },
    { type: 'waitForText', selector: 'body', includes: '执行成功', timeoutMs: 15000 },
  ];
}

/** 默认登录步骤（点击 OAuth 入口 → 人工授权） */
export function defaultLoginSteps(): Step[] {
  return [
    {
      type: 'click',
      selector: 'a[href*="oauth"], button.oauth, .login-oauth',
      timeoutMs: 15000,
      waitNavigation: false,
      watchPopup: true,
    },
    { type: 'manual', message: '请完成 OAuth 授权', match: '', timeoutMs: 180000 },
    { type: 'waitForUrl', match: '', timeoutMs: 60000 },
  ];
}

/** 默认验证技能：将页面交给用户处理，完成条件可在技能检测规则中配置。 */
export function defaultVerificationSteps(): Step[] {
  return [
    {
      type: 'manual',
      message: '请在当前页面完成安全验证，完成后将自动继续',
      match: '',
      timeoutMs: 180000,
    },
  ];
}

/**
 * 创建一个技能（Procedure）实体。
 * 「技能」是可复用的单页操作步骤集合（自动化 / 登录 / 验证技能），
 * 被站点或画布流程引用。画布上的节点图称为「流程」（Flow），见 lib/flows.js。
 */
export function createProcedure(partial: Partial<Procedure> = {}): Procedure {
  const now = Date.now();
  const kind: Procedure['kind'] = partial.kind === 'login' || partial.kind === 'verification'
    ? partial.kind
    : 'checkin';
  const base: ProcedureBase = {
    id: uid('proc'),
    siteId: '',
    kind,
    name: kind === 'login' ? '新登录技能' : kind === 'verification' ? '新验证技能' : '新自动化技能',
    description: '',
    detect:
      kind === 'login'
        ? {
            loggedInSelector: '',
            loggedInUrlIncludes: '',
            loginUrlPattern: '',
            notLoggedInKeywords: ['请登录', '登录后操作', '您需要登录'],
          }
        : kind === 'verification'
          ? {
              completedSelector: '',
              completedUrlIncludes: '',
            }
          : {
            successKeywords: ['执行成功', '已执行', 'already checked', 'success'],
            failKeywords: ['失败', '未登录', '请登录', 'login required'],
          },
    steps: kind === 'login'
      ? defaultLoginSteps()
      : kind === 'verification'
        ? defaultVerificationSteps()
        : defaultCheckinSteps(),
    // 技能工厂默认使用标准化动作序列；脚本只在调用方显式传入时保留，
    // 避免「steps + 默认脚本」同时存在，让新建或生成的技能看起来像脚本技能。
    script: '',
    source: 'local',
    author: '',
    homepage: '',
    version: '1.0.0',
    marketId: '',
    installedAt: 0,
    updatedAt: now,
    createdAt: now,
    lastResult: null,
    explorationHistory: [],
    patchHistory: [],
    output: { enabled: false, fields: [] },
  };
  const merged = { ...base, ...partial } as Procedure;
  if (!merged.output || typeof merged.output.enabled !== 'boolean') {
    merged.output = { enabled: false, fields: [] };
  } else if (!Array.isArray(merged.output.fields)) {
    merged.output.fields = [];
  }
  return merged;
}

export function createSite(partial: Partial<Site> = {}): Site {
  const now = Date.now();
  return {
    id: uid('site'),
    name: '新站点',
    url: 'https://',
    enabled: true,
    mode: 'steps',
    checkinProcedureId: '',
    loginProcedureId: null,
    verificationProcedureId: null,
    cfTimeoutMs: 90000,
    pageLoadTimeoutMs: 45000,
    stepsTimeoutMs: 120000,
    keepTabOnError: true,
    openInBackground: true,
    schedule: defaultSchedule(),
    lastResult: null,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

export const SCRIPT_TEMPLATE = `// 在目标页面中执行，需 return { ok: boolean, message: string }
// 可使用 async/await
const btn = document.querySelector('button.checkin, .checkin, #checkin');
if (!btn) {
  return { ok: false, message: '未找到操作按钮，请修改选择器' };
}
btn.click();
await new Promise((r) => setTimeout(r, 2000));
const text = document.body?.innerText || '';
const ok = /执行成功|已执行|success/i.test(text);
return { ok, message: ok ? '执行完成' : '已点击按钮，请根据页面确认结果' };
`;

export function createLog(partial: Partial<Log> = {}): Log {
  return {
    id: uid('log'),
    taskId: '',
    siteId: '',
    siteName: '',
    status: 'failed',
    message: '',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    cfWaitedMs: 0,
    ...partial,
  };
}

export function createTask(partial: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: uid('task'),
    trigger: 'manual',
    state: 'running',
    startedAt: now,
    finishedAt: 0,
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    ...partial,
  };
}

export const TASK_TRIGGER_LABEL: Record<TaskTrigger, string> = {
  manual: '手动全部执行',
  single: '单站点测试',
  schedule: '定时执行',
};

export const STATUS_LABEL: Record<RunStatus, string> = {
  success: '成功',
  failed: '失败',
  cf_timeout: '人机验证超时',
  need_login: '需登录',
  skipped: '已跳过',
  running: '运行中',
  waiting_cf: '等待防护',
};

/**
 * 日志状态对应的完整 badge 类名。
 * 必须返回完整串（而非拼接 `badge ${status}`）——Tailwind 的内容扫描
 * 看不到运行期拼出来的类名，插值写法会让 daisyUI 修饰符被裁掉。
 */
export const RUN_STATUS_BADGE: Record<RunStatus, string> = {
  success: 'badge badge-success',
  failed: 'badge badge-error',
  cf_timeout: 'badge badge-warning',
  need_login: 'badge badge-warning',
  skipped: 'badge badge-ghost',
  running: 'badge badge-info',
  waiting_cf: 'badge badge-warning',
};

export const PROCEDURE_KIND_LABEL: Record<Procedure['kind'], string> = {
  checkin: '自动化技能',
  login: '登录技能',
  verification: '验证技能',
};
