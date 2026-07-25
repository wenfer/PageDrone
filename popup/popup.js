import { MSG } from '../lib/messaging.js';
import { STATUS_LABEL } from '../lib/models.js';
import { getLogs } from '../lib/storage.js';

const $ = (sel) => document.querySelector(sel);

const statusDot = $('#statusDot');
const statusText = $('#statusText');
const siteList = $('#siteList');
const logList = $('#logList');
const btnRunAll = $('#btnRunAll');
const btnStop = $('#btnStop');
const btnRefresh = $('#btnRefresh');
const btnSettings = $('#btnSettings');
const welcome = $('#welcome');
const btnOpenOptions = $('#btnOpenOptions');

let pollTimer = null;

init();

async function init() {
  const openOptions = () => chrome.runtime.openOptionsPage();
  btnRunAll.addEventListener('click', onRunAll);
  btnStop?.addEventListener('click', onStop);
  btnRefresh.addEventListener('click', refresh);
  btnSettings.addEventListener('click', openOptions);
  btnOpenOptions?.addEventListener('click', openOptions);
  await refresh();
  pollTimer = setInterval(refresh, 1500);
  window.addEventListener('unload', () => clearInterval(pollTimer));
}

async function send(type, payload = {}) {
  try {
    return await chrome.runtime.sendMessage({ type, ...payload });
  } catch (e) {
    const msg = e?.message || String(e);
    if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
      throw new Error('后台未启动：请到 chrome://extensions 点击本扩展的「重新加载」');
    }
    throw e;
  }
}

async function refresh() {
  try {
    const res = await send(MSG.GET_STATUS);
    if (!res?.ok) throw new Error(res?.error || '获取状态失败');
    renderStatus(res.runtime, res.queueRunning);
    renderSites(res.sites || [], res.queueRunning);
    welcome?.classList.toggle('hidden', (res.sites || []).length > 0);
    const logs = await getLogs();
    renderLogs(logs.slice(0, 5));
    btnRunAll.disabled = !!res.queueRunning;
    if (btnStop) btnStop.disabled = false;
  } catch (e) {
    statusText.textContent = e.message || String(e);
    statusDot.className = 'dot error';
    welcome?.classList.remove('hidden');
    siteList.innerHTML = `<div class="empty">${escapeHtml(e.message || String(e))}</div>`;
    btnRunAll.disabled = false;
  }
}

async function onStop() {
  try {
    // 使用字面量 'STOP'，避免 SW 未更新时 MSG 常量不一致
    const res = await send('STOP', { reason: '用户强制停止' });
    if (!res?.ok) throw new Error(res?.error || '停止失败');
    statusText.textContent = '已强制停止，可重新签到';
    statusDot.className = 'dot';
    btnRunAll.disabled = false;
  } catch (e) {
    // 后台仍是旧版时，提示重新加载扩展
    const msg = e.message || String(e);
    if (/未知消息类型|Receiving end does not exist/i.test(msg)) {
      alert('强制停止失败：请到 chrome://extensions 点击本扩展的「重新加载」，然后再点强制停止。\n\n' + msg);
    } else {
      alert(msg);
    }
  }
  await refresh();
}

function renderStatus(runtime = {}, queueRunning) {
  const state = queueRunning ? runtime.state || 'running' : 'idle';
  statusDot.className = 'dot ' + (state === 'idle' ? '' : state);
  if (queueRunning) {
    const name = runtime.currentSiteName || '';
    statusText.textContent = runtime.message || (name ? `运行中：${name}` : '运行中…');
  } else {
    statusText.textContent = '空闲';
  }
}

function renderSites(sites, queueRunning) {
  if (!sites.length) {
    siteList.innerHTML =
      '<div class="empty">还没有站点，请先在设置中添加</div>';
    return;
  }
  siteList.innerHTML = '';
  for (const site of sites) {
    const el = document.createElement('div');
    el.className = 'site-item';
    const st = site.lastResult?.status;
    const label = st ? STATUS_LABEL[st] || st : '尚未签到';
    const badgeClass = st || '';
    const when = site.lastResult?.at
      ? formatTime(site.lastResult.at)
      : '';
    el.innerHTML = `
      <div class="site-name">
        ${escapeHtml(site.name)}
        ${site.enabled ? '' : '<span class="off">已禁用</span>'}
      </div>
      <div class="site-actions">
        <button class="btn sm run" data-id="${site.id}" ${queueRunning ? 'disabled' : ''}>签到</button>
      </div>
      <div class="site-meta">
        <span class="badge ${badgeClass}">${escapeHtml(label)}</span>
        ${when ? ` · ${when}` : ''}
        ${site.lastResult?.message ? `<div>${escapeHtml(site.lastResult.message)}</div>` : ''}
      </div>
    `;
    el.querySelector('.run').addEventListener('click', () => onRunSite(site.id));
    siteList.appendChild(el);
  }
}

function renderLogs(logs) {
  if (!logs.length) {
    logList.innerHTML = '<div class="empty">暂无日志</div>';
    return;
  }
  logList.innerHTML = '';
  for (const log of logs) {
    const el = document.createElement('div');
    el.className = 'log-item';
    el.innerHTML = `
      <div class="log-top">
        <div>
          <strong>${escapeHtml(log.siteName || log.siteId)}</strong>
          <span class="badge ${log.status}">${escapeHtml(STATUS_LABEL[log.status] || log.status)}</span>
        </div>
        <span class="log-time">${formatTime(log.finishedAt || log.startedAt)}</span>
      </div>
      <div class="log-msg">${escapeHtml(log.message || '')}</div>
    `;
    logList.appendChild(el);
  }
}

async function onRunAll() {
  btnRunAll.disabled = true;
  try {
    const res = await send(MSG.RUN_ALL);
    if (!res?.ok) throw new Error(res?.error || '启动失败');
    statusText.textContent = `已排队 ${res.queued} 个站点`;
    statusDot.className = 'dot running';
  } catch (e) {
    alert(e.message || String(e));
    btnRunAll.disabled = false;
  }
  await refresh();
}

async function onRunSite(siteId) {
  try {
    const res = await send(MSG.RUN_SITE, { siteId, force: true });
    if (!res?.ok) throw new Error(res?.error || '启动失败');
  } catch (e) {
    alert(e.message || String(e));
  }
  await refresh();
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
