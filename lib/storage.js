/** chrome.storage.local 封装 */

import { defaultSettings, createLog, createTask } from './models.js';

const KEYS = {
  sites: 'sites',
  logs: 'logs',
  tasks: 'tasks',
  settings: 'settings',
  runtime: 'runtime',
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

export async function getSettings() {
  const data = await chrome.storage.local.get(KEYS.settings);
  return { ...defaultSettings(), ...(data.settings || {}) };
}

export async function saveSettings(settings) {
  const merged = { ...(await getSettings()), ...settings };
  await chrome.storage.local.set({ [KEYS.settings]: merged });
  return merged;
}

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
  // 只保留最近 100 个任务
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

export async function exportAll() {
  const [sites, settings, logs, tasks] = await Promise.all([
    getSites(),
    getSettings(),
    getLogs(),
    getTasks(),
  ]);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    sites,
    settings,
    logs,
    tasks,
  };
}

export async function importSites(payload, { merge = true } = {}) {
  let sites = Array.isArray(payload) ? payload : payload?.sites;
  if (!Array.isArray(sites)) throw new Error('无效的导入数据');
  // 规范化
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
  if (payload?.settings && typeof payload.settings === 'object') {
    await saveSettings(payload.settings);
  }
  return sites;
}
