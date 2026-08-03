/** chrome.storage.local 封装 */

import { defaultSettings, createLog, createTask, createProcedure } from './models.js';

const KEYS = {
  sites: 'sites',
  logs: 'logs',
  tasks: 'tasks',
  procedures: 'procedures',
  settings: 'settings',
  runtime: 'runtime',
  schemaVersion: 'schemaVersion',
};

export async function getSites() {
  const data = await chrome.storage.local.get(KEYS.sites);
  return Array.isArray(data.sites) ? data.sites : [];
}

export async function saveSites(sites) {
  await chrome.storage.local.set({ [KEYS.sites]: sites });
}

export async function getSite(id) {
  const sites = await getSites();
  return sites.find((s) => s.id === id) || null;
}

export async function upsertSite(site) {
  const sites = await getSites();
  const idx = sites.findIndex((s) => s.id === site.id);
  site.updatedAt = Date.now();
  if (idx >= 0) sites[idx] = site;
  else sites.push(site);
  await saveSites(sites);
  return site;
}

export async function removeSite(id) {
  const sites = (await getSites()).filter((s) => s.id !== id);
  await saveSites(sites);
  return sites;
}

export async function updateSiteLastResult(id, lastResult) {
  const sites = await getSites();
  const idx = sites.findIndex((s) => s.id === id);
  if (idx < 0) return;
  sites[idx] = { ...sites[idx], lastResult, updatedAt: Date.now() };
  await saveSites(sites);
}

// —— Procedures ——

let procCache = null;
let procCacheDirty = true;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[KEYS.procedures]) procCacheDirty = true;
});

async function loadProcedures() {
  if (procCacheDirty || !procCache) {
    const data = await chrome.storage.local.get(KEYS.procedures);
    procCache = Array.isArray(data.procedures) ? data.procedures : [];
    procCacheDirty = false;
  }
  return procCache;
}

export async function getProcedures() {
  return loadProcedures();
}

export async function saveProcedures(list) {
  procCache = list;
  procCacheDirty = false;
  await chrome.storage.local.set({ [KEYS.procedures]: list });
}

export async function getProcedure(id) {
  if (!id) return null;
  const list = await loadProcedures();
  return list.find((p) => p.id === id) || null;
}

export async function getProcedureByMarketId(marketId) {
  if (!marketId) return null;
  const list = await loadProcedures();
  return list.find((p) => p.marketId === marketId) || null;
}

export async function upsertProcedure(proc) {
  const list = await loadProcedures();
  const idx = list.findIndex((p) => p.id === proc.id);
  proc.updatedAt = Date.now();
  if (idx >= 0) list[idx] = { ...list[idx], ...proc };
  else list.push(proc);
  await saveProcedures(list);
  return proc;
}

export async function removeProcedure(id) {
  const list = (await loadProcedures()).filter((p) => p.id !== id);
  await saveProcedures(list);
}

/** 把一个导入的 procedure 规范化后入库；同 id / marketId 时按策略处理 */
export async function importProcedure(raw, { overwrite = false } = {}) {
  const proc = createProcedure({ ...raw, source: raw.source || 'local' });
  const list = await loadProcedures();
  const byId = list.find((p) => p.id === proc.id);
  const byMarket = proc.marketId ? list.find((p) => p.marketId === proc.marketId) : null;
  const existing = byId || byMarket;
  if (existing) {
    if (!overwrite) return { procedure: existing, duplicated: true };
    proc.id = existing.id;
    const idx = list.indexOf(existing);
    list[idx] = { ...existing, ...proc, updatedAt: Date.now() };
    await saveProcedures(list);
    return { procedure: list[idx], duplicated: false, overwrote: true };
  }
  list.push(proc);
  await saveProcedures(list);
  return { procedure: proc, duplicated: false };
}

// —— Settings ——

export async function getSettings() {
  const data = await chrome.storage.local.get(KEYS.settings);
  return { ...defaultSettings(), ...(data.settings || {}) };
}

export async function saveSettings(settings) {
  const merged = { ...(await getSettings()), ...settings };
  await chrome.storage.local.set({ [KEYS.settings]: merged });
  return merged;
}

// —— Logs ——

export async function getLogs() {
  const data = await chrome.storage.local.get(KEYS.logs);
  return Array.isArray(data.logs) ? data.logs : [];
}

export async function appendLog(entry) {
  const settings = await getSettings();
  const logs = await getLogs();
  const log = createLog(entry);
  logs.unshift(log);
  const max = settings.maxLogs || 200;
  if (logs.length > max) logs.length = max;
  await chrome.storage.local.set({ [KEYS.logs]: logs });
  return log;
}

export async function getTasks() {
  const data = await chrome.storage.local.get(KEYS.tasks);
  return Array.isArray(data.tasks) ? data.tasks : [];
}

export async function saveTasks(tasks) {
  await chrome.storage.local.set({ [KEYS.tasks]: tasks });
}

export async function upsertTask(task) {
  const tasks = await getTasks();
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) tasks[idx] = { ...tasks[idx], ...task };
  else tasks.unshift(task);
  if (tasks.length > 100) tasks.length = 100;
  await saveTasks(tasks);
  return task;
}

export async function startTask(partial) {
  const task = createTask(partial);
  await upsertTask(task);
  return task;
}

export async function clearLogs() {
  await chrome.storage.local.set({ [KEYS.logs]: [], [KEYS.tasks]: [] });
}

// —— Runtime ——

export async function getRuntime() {
  const data = await chrome.storage.local.get(KEYS.runtime);
  return data.runtime || {
    state: 'idle',
    currentSiteId: null,
    currentSiteName: null,
    queue: [],
    message: '',
    updatedAt: 0,
  };
}

export async function setRuntime(partial) {
  const cur = await getRuntime();
  const next = { ...cur, ...partial, updatedAt: Date.now() };
  await chrome.storage.local.set({ [KEYS.runtime]: next });
  return next;
}

// —— Schema version ——

export async function getSchemaVersion() {
  const data = await chrome.storage.local.get(KEYS.schemaVersion);
  return data.schemaVersion || 1;
}

export async function setSchemaVersion(v) {
  await chrome.storage.local.set({ [KEYS.schemaVersion]: v });
}

// —— Import / Export ——

export async function exportAll() {
  const [sites, settings, logs, tasks, procedures] = await Promise.all([
    getSites(),
    getSettings(),
    getLogs(),
    getTasks(),
    getProcedures(),
  ]);
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    sites,
    settings,
    logs,
    tasks,
    procedures,
  };
}

export async function importSites(payload, { merge = true } = {}) {
  let sites = Array.isArray(payload) ? payload : payload?.sites;
  if (!Array.isArray(sites)) throw new Error('无效的导入数据');
  sites = sites.map((s) => ({
    ...s,
    id: s.id || `site_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    updatedAt: Date.now(),
  }));
  if (merge) {
    const existing = await getSites();
    const map = new Map(existing.map((s) => [s.id, s]));
    for (const s of sites) map.set(s.id, { ...map.get(s.id), ...s });
    sites = [...map.values()];
  }
  await saveSites(sites);

  // 附带导入 procedures
  if (Array.isArray(payload?.procedures)) {
    const list = await getProcedures();
    const map = new Map(list.map((p) => [p.id, p]));
    for (const raw of payload.procedures) {
      const proc = createProcedure({ ...raw, source: raw.source || 'local' });
      if (!map.has(proc.id)) map.set(proc.id, proc);
    }
    await saveProcedures([...map.values()]);
  }
  if (payload?.settings && typeof payload.settings === 'object') {
    await saveSettings(payload.settings);
  }
  return sites;
}
