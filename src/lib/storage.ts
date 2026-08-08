/** chrome.storage.local 封装 */

import {
  defaultSettings,
  createLog,
  createTask,
  createProcedure,
  type Site,
  type Procedure,
  type Settings,
  type Log,
  type Task,
  type Flow,
  type LastResult,
} from './models.js';
import { RUN_STATE, type RunState } from './messaging.js';
import { convertV1Sites, normalizeProcedureSiteOwnership } from './v1-convert.js';
import type { AgentChatSessionRecord, FlowTestReport } from './types.js';

const KEYS = {
  sites: 'sites',
  logs: 'logs',
  tasks: 'tasks',
  procedures: 'procedures',
  settings: 'settings',
  runtime: 'runtime',
  agentChatSessions: 'agentChatSessions',
  schemaVersion: 'schemaVersion',
  flowTestReports: 'flowTestReports',
} as const;

const MAX_AGENT_CHAT_SESSIONS = 40;
const MAX_AGENT_CHAT_TURNS = 120;
const MAX_FLOW_TEST_REPORTS_PER_FLOW = 20;

export async function getFlowTestReports(flowId?: string): Promise<Array<FlowTestReport & { id: string }>> {
  const data = await chrome.storage.local.get(KEYS.flowTestReports);
  const reports = Array.isArray(data[KEYS.flowTestReports]) ? data[KEYS.flowTestReports] as Array<FlowTestReport & { id: string }> : [];
  return (flowId ? reports.filter((report) => report.flowId === flowId) : reports)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
}

export async function saveFlowTestReport(report: FlowTestReport): Promise<void> {
  const data = await chrome.storage.local.get(KEYS.flowTestReports);
  const reports = Array.isArray(data[KEYS.flowTestReports]) ? data[KEYS.flowTestReports] as Array<FlowTestReport & { id: string }> : [];
  reports.unshift({ ...report, id: report.requestId || `${report.flowId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` });
  const byFlow = new Map<string, Array<FlowTestReport & { id: string }>>();
  for (const item of reports) {
    const list = byFlow.get(item.flowId) ?? [];
    if (list.length < MAX_FLOW_TEST_REPORTS_PER_FLOW) list.push(item);
    byFlow.set(item.flowId, list);
  }
  await chrome.storage.local.set({ [KEYS.flowTestReports]: [...byFlow.values()].flat() });
}

export interface RuntimeStateShape {
  state: RunState;
  currentSiteId: string | null;
  currentSiteName: string | null;
  queue: string[];
  message: string;
  updatedAt: number;
  [key: string]: unknown;
}

// —— Sites ——

export async function getSites(): Promise<Site[]> {
  const data = await chrome.storage.local.get(KEYS.sites);
  return Array.isArray(data.sites) ? (data.sites as Site[]) : [];
}

export async function saveSites(sites: Site[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.sites]: sites });
}

export async function getSite(id: string): Promise<Site | null> {
  const sites = await getSites();
  return sites.find((s) => s.id === id) || null;
}

export async function upsertSite(site: Site): Promise<Site> {
  // 默认执行入口是网站下技能的快捷引用，不能把其他网站的技能绑定进来。
  // 关系本身由 Procedure.siteId 建立，这里在后台再做一次完整性校验，避免
  // Agent 或其他非 React 调用方绕过网站技能筛选后写入脏数据。
  const procedures = await getProcedures();
  const bindings: Array<[string, string | null | undefined, Procedure['kind']]> = [
    ['自动化技能', site.checkinProcedureId, 'checkin'],
    ['登录技能', site.loginProcedureId, 'login'],
    ['验证技能', site.verificationProcedureId, 'verification'],
  ];
  for (const [label, procedureId, expectedKind] of bindings) {
    if (!procedureId) continue;
    const procedure = procedures.find((item) => item.id === procedureId);
    if (!procedure) throw new Error(`${label}不存在，请刷新后重新选择`);
    if (procedure.siteId !== site.id) throw new Error(`${label}必须属于当前网站`);
    if (procedure.kind !== expectedKind) throw new Error(`${label}类型不匹配，请重新选择`);
  }
  const sites = await getSites();
  const idx = sites.findIndex((s) => s.id === site.id);
  site.updatedAt = Date.now();
  if (idx >= 0) sites[idx] = site;
  else sites.push(site);
  await saveSites(sites);
  return site;
}

export async function removeSite(id: string): Promise<Site[]> {
  const sites = (await getSites()).filter((s) => s.id !== id);
  await saveSites(sites);
  // 网站是技能的拥有者；调用底层删除 API 时同步删除其子技能，避免留下无主数据。
  const procedures = (await getProcedures()).filter((procedure) => procedure.siteId !== id);
  await saveProcedures(procedures);
  return sites;
}

export async function updateSiteLastResult(id: string, lastResult: LastResult): Promise<void> {
  const sites = await getSites();
  const idx = sites.findIndex((s) => s.id === id);
  if (idx < 0) return;
  sites[idx] = { ...sites[idx]!, lastResult, updatedAt: Date.now() };
  await saveSites(sites);
}

// —— Procedures ——

let procCache: Procedure[] | null = null;
let procCacheDirty = true;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[KEYS.procedures]) procCacheDirty = true;
});

async function loadProcedures(): Promise<Procedure[]> {
  if (procCacheDirty || !procCache) {
    const data = await chrome.storage.local.get(KEYS.procedures);
    procCache = Array.isArray(data.procedures) ? (data.procedures as Procedure[]) : [];
    procCacheDirty = false;
  }
  return procCache;
}

export async function getProcedures(): Promise<Procedure[]> {
  return loadProcedures();
}

export async function saveProcedures(list: Procedure[]): Promise<void> {
  procCache = list;
  procCacheDirty = false;
  await chrome.storage.local.set({ [KEYS.procedures]: list });
}

export async function getProcedure(id: string): Promise<Procedure | null> {
  if (!id) return null;
  const list = await loadProcedures();
  return list.find((p) => p.id === id) || null;
}

export async function getProcedureByMarketId(marketId: string, siteId = ''): Promise<Procedure | null> {
  if (!marketId) return null;
  const list = await loadProcedures();
  return list.find((p) => p.marketId === marketId && (!siteId || p.siteId === siteId)) || null;
}

export async function upsertProcedure(proc: Procedure): Promise<Procedure> {
  if (!proc.output || typeof proc.output.enabled !== 'boolean') {
    proc.output = { enabled: false, fields: [] };
  } else if (!Array.isArray(proc.output.fields)) {
    proc.output.fields = [];
  }
  const list = await loadProcedures();
  const idx = list.findIndex((p) => p.id === proc.id);
  const previous = idx >= 0 ? list[idx] : null;
  proc.updatedAt = Date.now();
  if (idx >= 0) list[idx] = { ...list[idx]!, ...proc };
  else list.push(proc);
  await saveProcedures(list);

  // 技能归属网站后，站点的默认自动化/登录/验证入口只能指向自己的子技能。
  // 这里兼容旧调用方：创建网站技能时若对应入口为空，自动将其设为默认技能。
  if (proc.siteId) {
    const sites = await getSites();
    let sitesChanged = false;
    for (const site of sites) {
      if (site.id !== proc.siteId) {
        if (site.checkinProcedureId === proc.id) { site.checkinProcedureId = ''; sitesChanged = true; }
        if (site.loginProcedureId === proc.id) { site.loginProcedureId = null; sitesChanged = true; }
        if (site.verificationProcedureId === proc.id) { site.verificationProcedureId = null; sitesChanged = true; }
        continue;
      }
      if (proc.kind === 'checkin' && !site.checkinProcedureId) { site.checkinProcedureId = proc.id; sitesChanged = true; }
      if (proc.kind === 'login' && !site.loginProcedureId) { site.loginProcedureId = proc.id; sitesChanged = true; }
      if (proc.kind === 'verification' && !site.verificationProcedureId) { site.verificationProcedureId = proc.id; sitesChanged = true; }
    }
    if (previous?.siteId && previous.siteId !== proc.siteId) {
      const oldSite = sites.find((site) => site.id === previous.siteId);
      if (oldSite?.checkinProcedureId === proc.id) { oldSite.checkinProcedureId = ''; sitesChanged = true; }
      if (oldSite?.loginProcedureId === proc.id) { oldSite.loginProcedureId = null; sitesChanged = true; }
      if (oldSite?.verificationProcedureId === proc.id) { oldSite.verificationProcedureId = null; sitesChanged = true; }
    }
    if (sitesChanged) await saveSites(sites);
  }
  return proc;
}

export async function removeProcedure(id: string): Promise<void> {
  const list = (await loadProcedures()).filter((p) => p.id !== id);
  await saveProcedures(list);
  const sites = await getSites();
  let changed = false;
  for (const site of sites) {
    if (site.checkinProcedureId === id) { site.checkinProcedureId = ''; changed = true; }
    if (site.loginProcedureId === id) { site.loginProcedureId = null; changed = true; }
    if (site.verificationProcedureId === id) { site.verificationProcedureId = null; changed = true; }
  }
  if (changed) await saveSites(sites);
}

// —— Settings ——

export async function getSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(KEYS.settings);
  return { ...defaultSettings(), ...(data.settings as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Partial<Settings>): Promise<Settings> {
  const merged = { ...(await getSettings()), ...settings };
  await chrome.storage.local.set({ [KEYS.settings]: merged });
  return merged;
}

// —— AI 对话历史 ——

export async function getAgentChatSessions(): Promise<AgentChatSessionRecord[]> {
  const data = await chrome.storage.local.get(KEYS.agentChatSessions);
  const sessions = Array.isArray(data.agentChatSessions)
    ? data.agentChatSessions as AgentChatSessionRecord[]
    : [];
  return sessions
    .filter((session) => session && typeof session.id === 'string')
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveAgentChatSessions(sessions: AgentChatSessionRecord[]): Promise<void> {
  const normalized = [...sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_AGENT_CHAT_SESSIONS)
    .map((session) => ({
      ...session,
      turns: session.turns.slice(-MAX_AGENT_CHAT_TURNS),
    }));
  await chrome.storage.local.set({ [KEYS.agentChatSessions]: normalized });
}

export async function upsertAgentChatSession(session: AgentChatSessionRecord): Promise<void> {
  const sessions = await getAgentChatSessions();
  const index = sessions.findIndex((item) => item.id === session.id);
  if (index >= 0) sessions[index] = session;
  else sessions.unshift(session);
  await saveAgentChatSessions(sessions);
}

export async function removeAgentChatSession(id: string): Promise<void> {
  await saveAgentChatSessions((await getAgentChatSessions()).filter((session) => session.id !== id));
}

// —— Logs ——

export async function getLogs(): Promise<Log[]> {
  const data = await chrome.storage.local.get(KEYS.logs);
  return Array.isArray(data.logs) ? (data.logs as Log[]) : [];
}

export async function appendLog(entry: Partial<Log>): Promise<Log> {
  const settings = await getSettings();
  const logs = await getLogs();
  const log = createLog(entry);
  logs.unshift(log);
  const max = settings.maxLogs || 200;
  if (logs.length > max) logs.length = max;
  await chrome.storage.local.set({ [KEYS.logs]: logs });
  return log;
}

export async function getTasks(): Promise<Task[]> {
  const data = await chrome.storage.local.get(KEYS.tasks);
  return Array.isArray(data.tasks) ? (data.tasks as Task[]) : [];
}

async function saveTasks(tasks: Task[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.tasks]: tasks });
}

export async function upsertTask(task: Partial<Task> & { id: string }): Promise<Task> {
  const tasks = await getTasks();
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) tasks[idx] = { ...tasks[idx]!, ...task };
  else tasks.unshift(task as Task);
  if (tasks.length > 100) tasks.length = 100;
  await saveTasks(tasks);
  return task as Task;
}

export async function startTask(partial: Partial<Task>): Promise<Task> {
  const task = createTask(partial);
  await upsertTask(task);
  return task;
}

export async function clearLogs(): Promise<void> {
  await chrome.storage.local.set({ [KEYS.logs]: [], [KEYS.tasks]: [] });
}

// —— Runtime ——

export async function getRuntime(): Promise<RuntimeStateShape> {
  const data = await chrome.storage.local.get(KEYS.runtime);
  return (data.runtime as RuntimeStateShape) || {
    state: RUN_STATE.IDLE,
    currentSiteId: null,
    currentSiteName: null,
    queue: [],
    message: '',
    updatedAt: 0,
  };
}

export async function setRuntime(partial: Partial<RuntimeStateShape>): Promise<RuntimeStateShape> {
  const cur = await getRuntime();
  const next = { ...cur, ...partial, updatedAt: Date.now() };
  await chrome.storage.local.set({ [KEYS.runtime]: next });
  return next;
}

// —— Schema version ——

export async function getSchemaVersion(): Promise<number> {
  const data = await chrome.storage.local.get(KEYS.schemaVersion);
  return (data.schemaVersion as number) || 1;
}

export async function setSchemaVersion(v: number): Promise<void> {
  await chrome.storage.local.set({ [KEYS.schemaVersion]: v });
}

// —— Import / Export ——

export interface ExportPayload {
  version: number;
  exportedAt: string;
  sites: Site[];
  settings: Settings;
  logs: Log[];
  tasks: Task[];
  procedures: Procedure[];
  flows: Flow[];
}

export async function exportAll(): Promise<ExportPayload> {
  const [sites, settings, logs, tasks, procedures, flowsData] = await Promise.all([
    getSites(),
    getSettings(),
    getLogs(),
    getTasks(),
    getProcedures(),
    chrome.storage.local.get('flows'),
  ]);
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    sites,
    settings,
    logs,
    tasks,
    procedures,
    flows: Array.isArray(flowsData.flows) ? (flowsData.flows as Flow[]) : [],
  };
}

export async function importSites(
  payload: { sites?: Site[]; procedures?: unknown[]; flows?: Flow[]; settings?: Partial<Settings>; logs?: Log[]; tasks?: Task[] } | Site[],
  { merge = true }: { merge?: boolean } = {}
): Promise<Site[]> {
  // 注意：旧版这里是 `payload?.sites`（无 ?? []），若 payload 不含 sites 数组会
  // 在下面抛错。写成 `?? []` 会让替换模式把空数组落盘，等于清空用户全部站点。
  const rawSites = Array.isArray(payload) ? payload : payload?.sites;
  if (!Array.isArray(rawSites)) throw new Error('无效的导入数据');
  let sites: Site[] = rawSites;
  sites = sites.map((s) => ({
    ...s,
    id: s.id || `site_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    updatedAt: Date.now(),
  }));

  // 旧版（v1）导出把 steps/login 内联在站点里，runner 只认 checkinProcedureId，
  // 不转换就会导致导入后站点没有可执行步骤。顺带收集转换生成的技能一并入库。
  const { newProcedures: migratedProcedures } = convertV1Sites(sites);

  if (merge) {
    const existing = await getSites();
    const map = new Map(existing.map((s) => [s.id, s]));
    for (const s of sites) map.set(s.id, { ...map.get(s.id), ...s } as Site);
    sites = [...map.values()];
  }
  await saveSites(sites);

  // 附带导入 procedures（技能），以及上面从 v1 站点转换生成的技能
  const hasProceduresPayload = !Array.isArray(payload) && Array.isArray(payload?.procedures);
  const incomingProcs = !Array.isArray(payload) && Array.isArray(payload?.procedures) ? payload.procedures : [];
  if (hasProceduresPayload || migratedProcedures.length) {
    const list = hasProceduresPayload && !merge ? [] : await getProcedures();
    const map = new Map(list.map((p) => [p.id, p]));
    for (const raw of incomingProcs) {
      const proc = createProcedure({ ...(raw as Partial<Procedure>), source: (raw as { source?: Procedure['source'] }).source || 'local' });
      map.set(proc.id, proc);
    }
    for (const proc of migratedProcedures) {
      map.set(proc.id, proc);
    }
    await saveProcedures([...map.values()]);
  }
  // 即使备份只包含站点，也要让已有技能按网站归属重新归一化。
  const normalized = normalizeProcedureSiteOwnership(sites, await getProcedures());
  if (normalized.changed) {
    await saveProcedures(normalized.procedures);
    await saveSites(normalized.sites);
    sites = normalized.sites;
  }
  // 附带导入 flows（画布流程）
  const flowsPayload = !Array.isArray(payload) ? payload?.flows : undefined;
  if (Array.isArray(flowsPayload)) {
    const existing = merge ? (((await chrome.storage.local.get('flows')).flows as Flow[]) || []) : [];
    const map = new Map(existing.map((f) => [f.id, f]));
    for (const raw of flowsPayload) {
      if (!raw || !raw.id || !raw.name) continue;
      map.set(raw.id, { ...raw, updatedAt: Date.now() });
    }
    await chrome.storage.local.set({ flows: [...map.values()] });
  }
  // 完整备份同时恢复日志和批次记录。合并模式按 id 更新，替换模式只替换
  // 备份中明确包含的集合，避免旧版备份意外清空新数据。
  const logsPayload = !Array.isArray(payload) ? payload?.logs : undefined;
  if (Array.isArray(logsPayload)) {
    const existing = merge ? await getLogs() : [];
    const map = new Map(existing.map((item) => [item.id, item]));
    for (const raw of logsPayload) {
      if (raw && typeof raw.id === 'string') map.set(raw.id, raw);
    }
    await chrome.storage.local.set({ [KEYS.logs]: [...map.values()] });
  }
  const tasksPayload = !Array.isArray(payload) ? payload?.tasks : undefined;
  if (Array.isArray(tasksPayload)) {
    const existing = merge ? await getTasks() : [];
    const map = new Map(existing.map((item) => [item.id, item]));
    for (const raw of tasksPayload) {
      if (raw && typeof raw.id === 'string') map.set(raw.id, raw);
    }
    await chrome.storage.local.set({ [KEYS.tasks]: [...map.values()] });
  }
  const settingsPayload = !Array.isArray(payload) ? payload?.settings : undefined;
  if (settingsPayload && typeof settingsPayload === 'object') {
    await saveSettings(settingsPayload);
  }
  return sites;
}
