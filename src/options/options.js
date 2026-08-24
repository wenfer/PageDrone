import { MSG, RUN_STATE } from '../lib/messaging.js';
import {
  createSite,
  createProcedure,
  SCRIPT_TEMPLATE,
  STATUS_LABEL,
  RUN_STATUS_BADGE,
  TASK_TRIGGER_LABEL,
  PROCEDURE_KIND_LABEL,
} from '../lib/models.js';
import {
  getSites,
  upsertSite,
  removeSite,
  getSettings,
  saveSettings,
  getLogs,
  getTasks,
  clearLogs,
  exportAll,
  importSites,
  getProcedures,
  upsertProcedure,
  removeProcedure,
} from '../lib/storage.js';
import { getFlows, saveFlow, deleteFlow, createFlow } from '../lib/flows.js';
import { compareVersions } from '../lib/market.js';
import { addStepRow, collectSteps, STEP_UI } from './step-editor.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let sites = [];
let procedures = [];
let flows = [];
let settings = {};
let currentSiteId = null;
let currentProcId = null;
let procFilter = { kind: '', q: '' };
let marketFilter = { kind: '', q: '' };
let marketIndex = null;
let llmModels = [];
let llmModelActiveIndex = -1;
let llmModelShowAll = true;

init();

// 设置可能由本页保存、导入或其他扩展页面修改。始终同步内存快照，
// 让 AI 探索/Agent 入口无需刷新即可看到最新配置；不主动回填表单，避免覆盖未保存输入。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings?.newValue) {
    settings = { ...settings, ...changes.settings.newValue };
  }
});

async function init() {
  loadVersion();
  bindNav();
  bindSiteEditor();
  bindProcEditor();
  bindMarket();
  bindFlows();
  bindSettingsAndIo();
  bindExplore();
  bindAgentChat();
  bindRecord();
  bindIntervention();

  await reloadAll();

  // 自动刷新
  setInterval(async () => {
    if ($$('#tab-logs.active').length) await renderLogs();
  }, 3000);

  // 介入状态轮询：执行步骤失败挂起时，展示介入面板
  setInterval(pollInterventionState, 1500);
}

function bindNav() {
  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

async function reloadAll() {
  [sites, procedures, settings, flows] = await Promise.all([
    getSites(),
    getProcedures(),
    getSettings(),
    getFlows(),
  ]);
  renderSiteList();
  renderProcList();
  renderProcKindOptions();
  renderFlowList();
  fillMarketUrl();
  if (currentSiteId && sites.some((s) => s.id === currentSiteId)) {
    selectSite(currentSiteId);
  } else if (sites[0]) {
    selectSite(sites[0].id);
  } else {
    currentSiteId = null;
    $('#siteForm').classList.add('hidden');
    $('#editorEmpty').classList.remove('hidden');
  }
  if (currentProcId && procedures.some((p) => p.id === currentProcId)) {
    selectProc(currentProcId);
  } else {
    $('#procForm').classList.add('hidden');
    $('#procEditorEmpty').classList.remove('hidden');
  }
  await loadSettingsForm();
  await renderLogs();
  handleDeepLink();
}

// 支持从画布跳转：options.html#proc/<id> 打开任务库并选中指定任务
function handleDeepLink() {
  const hash = location.hash || '';
  const procMatch = hash.match(/^#proc\/(.+)$/);
  if (procMatch) {
    const id = decodeURIComponent(procMatch[1]);
    if (procedures.some((p) => p.id === id)) {
      switchTab('procedures');
      selectProc(id);
    }
  }
}

// —— 版本 ——
async function loadVersion() {
  try {
    const m = await fetch(chrome.runtime.getURL('manifest.json')).then((r) => r.json());
    $$('#versionLabel').forEach((el) => (el.textContent = 'v' + (m.version || '?')));
  } catch { /* ignore */ }
}

function switchTab(name) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  if (name === 'logs') renderLogs();
  if (name === 'settings') loadSettingsForm();
  if (name === 'market' && !marketIndex) refreshMarket();
  if (name === 'procedures') renderProcList();
}

// ===================== 站点 =====================

function renderSiteList() {
  const list = $('#siteList');
  list.innerHTML = '';
  $('#siteCount').textContent = sites.length;
  renderStats();
  if (!sites.length) {
    list.innerHTML = '<div class="empty-hint compact">暂无站点<br><small>点右上角「新建站点」开始</small></div>';
    return;
  }
  for (const site of sites) {
    const el = document.createElement('div');
    el.className = 'site-card' + (site.id === currentSiteId ? ' active' : '');
    const st = site.lastResult?.status;
    const dotCls = st ? `dot-${st}` : 'dot-never';
    const host = shortHost(site.url);
    el.title = `${site.name}\n${site.url}`;
    el.innerHTML = `
      <span class="status-dot ${dotCls}" title="${st ? STATUS_LABEL[st] || st : '未执行'}"></span>
      <span class="name">${escapeHtml(site.name)}</span>
      <span class="host">${escapeHtml(host)}</span>
      ${site.enabled ? '' : '<span class="mini-badge off">禁用</span>'}
      ${site.schedule?.enabled ? '<span class="mini-badge sched" title="已开启定时">⏰</span>' : ''}
    `;
    el.addEventListener('click', () => selectSite(site.id));
    list.appendChild(el);
  }
}

function renderStats() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
  const enabled = sites.filter((s) => s.enabled !== false);
  set('statTotal', sites.length);
  set('statEnabled', enabled.length);
  set('statScheduled', enabled.filter((s) => s.schedule?.enabled).length);
  set('statSuccess', sites.filter((s) => s.lastResult?.status === 'success' && isToday(s.lastResult.at)).length);
  set('statFailed', sites.filter((s) => s.enabled !== false && ['failed', 'cf_timeout', 'need_login'].includes(s.lastResult?.status)).length);
}

function isToday(ts) {
  if (!ts) return false;
  const d = new Date(ts), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

function shortHost(url) {
  try { return new URL(url).host.replace(/^www\./, ''); }
  catch { return String(url || '').replace(/^https?:\/\//, '').split('/')[0] || ''; }
}

function selectSite(id) {
  currentSiteId = id;
  const site = sites.find((s) => s.id === id);
  renderSiteList();
  if (!site) return;
  fillSiteForm(site);
  $('#editorEmpty').classList.add('hidden');
  $('#siteForm').classList.remove('hidden');
  setFormMsg('');
}

function onNewSite() {
  // 自动创建一个默认自动化技能并绑定
  const proc = createProcedure({ kind: 'checkin', name: '新自动化技能' });
  procedures.push(proc);
  const site = createSite({ name: '新站点', checkinProcedureId: proc.id });
  currentSiteId = site.id;
  sites = [site, ...sites.filter((s) => s.id !== site.id)];
  fillSiteForm(site);
  renderSiteList();
  renderProcList();
  renderProcKindOptions();
  $('#editorEmpty').classList.add('hidden');
  $('#siteForm').classList.remove('hidden');
  setFormMsg('请填写后点击保存（已自动创建默认自动化技能）', '');
}

function fillSiteForm(site) {
  const form = $('#siteForm');
  form.name.value = site.name || '';
  form.url.value = site.url || '';
  form.enabled.checked = site.enabled !== false;
  form.openInBackground.checked = site.openInBackground !== false;
  form.keepTabOnError.checked = site.keepTabOnError !== false;
  form.querySelectorAll('[name="mode"]').forEach((r) => { r.checked = r.value === (site.mode || 'steps'); });
  form.cfTimeoutMs.value = site.cfTimeoutMs ?? 90000;
  form.pageLoadTimeoutMs.value = site.pageLoadTimeoutMs ?? 45000;
  form.scheduleEnabled.checked = !!site.schedule?.enabled;
  form.scheduleHour.value = site.schedule?.hour ?? 8;
  form.scheduleMinute.value = site.schedule?.minute ?? 5;

  renderProcKindOptions();
  form.checkinProcedureId.value = site.checkinProcedureId || '';
  form.loginProcedureId.value = site.loginProcedureId || '';
  renderProcPreviews(site);

  // detail head
  $('#detailTitle').textContent = site.name || '未命名站点';
  const urlEl = $('#detailUrl');
  urlEl.textContent = site.url || '';
  urlEl.href = /^https?:\/\//i.test(site.url) ? site.url : '#';
  const lastEl = $('#detailLast');
  const st = site.lastResult?.status;
  if (st) {
    lastEl.textContent = `${STATUS_LABEL[st] || st} · ${formatTime(site.lastResult.at)}`;
    lastEl.className = 'meta-value badge-like status-' + st;
  } else {
    lastEl.textContent = '尚未执行';
    lastEl.className = 'meta-value badge-like';
  }
  const schedEl = $('#detailSched');
  if (site.schedule?.enabled) {
    schedEl.textContent = `每日 ${String(site.schedule.hour ?? 8).padStart(2, '0')}:${String(site.schedule.minute ?? 5).padStart(2, '0')}`;
  } else {
    schedEl.textContent = '未开启';
  }
}

function renderProcKindOptions() {
  const checkinSel = $('#f-checkinProc');
  const loginSel = $('#f-loginProc');
  if (!checkinSel) return;
  const curC = checkinSel.value;
  const curL = loginSel.value;
  const checkins = procedures.filter((p) => p.kind === 'checkin');
  const logins = procedures.filter((p) => p.kind === 'login');
  checkinSel.innerHTML = checkins.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}${p.source === 'market' ? '  ⬇' : ''}</option>`).join('') || '<option value="">（请先到任务库新建）</option>';
  if (curC && checkins.some((p) => p.id === curC)) checkinSel.value = curC;
  loginSel.innerHTML = '<option value="">（不使用登录技能）</option>' + logins.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}${p.source === 'market' ? '  ⬇' : ''}</option>`).join('');
  if (curL && logins.some((p) => p.id === curL)) loginSel.value = curL;
}

function renderProcPreviews(site) {
  const cp = procedures.find((p) => p.id === site.checkinProcedureId);
  const lp = procedures.find((p) => p.id === site.loginProcedureId);
  $('#checkinProcPreview').innerHTML = cp ? procPreviewHtml(cp) : '<span class="hint">未选择自动化技能</span>';
  $('#loginProcPreview').innerHTML = lp ? procPreviewHtml(lp) : '<span class="hint">不需要登录技能可留空</span>';
}

function procPreviewHtml(p) {
  const steps = (p.steps || []).map((s, i) => `<li>${i + 1}. ${escapeHtml(STEP_UI[s.type]?.desc?.replace(/<[^>]+>/g, '').slice(0, 40) || s.type)}</li>`).join('');
  const meta = [];
  if (p.author) meta.push(escapeHtml(p.author));
  if (p.version) meta.push('v' + escapeHtml(p.version));
  if (p.source === 'market') meta.push('市场');
  return `
    <div class="proc-preview-head">
      <strong>${escapeHtml(p.name)}</strong>
      <span class="kind-tag kind-${p.kind}">${PROCEDURE_KIND_LABEL[p.kind]}</span>
      ${meta.map((m) => `<span class="mini-badge">${m}</span>`).join('')}
    </div>
    ${p.description ? `<div class="hint">${escapeHtml(p.description)}</div>` : ''}
    ${steps ? `<ol class="proc-step-preview">${steps}</ol>` : '<div class="hint">（自定义脚本模式）</div>'}
  `;
}

function collectSiteFromForm() {
  const form = $('#siteForm');
  const existing = sites.find((s) => s.id === currentSiteId) || createSite({ id: currentSiteId });
  return {
    ...existing,
    id: currentSiteId || existing.id,
    name: form.name.value.trim(),
    url: form.url.value.trim(),
    enabled: form.enabled.checked,
    openInBackground: form.openInBackground.checked,
    keepTabOnError: form.keepTabOnError.checked,
    mode: form.querySelector('[name="mode"]:checked')?.value || 'steps',
    checkinProcedureId: form.checkinProcedureId.value,
    loginProcedureId: form.loginProcedureId.value || null,
    cfTimeoutMs: Number(form.cfTimeoutMs.value) || 90000,
    pageLoadTimeoutMs: Number(form.pageLoadTimeoutMs.value) || 45000,
    schedule: {
      enabled: form.scheduleEnabled.checked,
      type: 'daily',
      hour: clamp(Number(form.scheduleHour.value), 0, 23, 8),
      minute: clamp(Number(form.scheduleMinute.value), 0, 59, 5),
    },
    updatedAt: Date.now(),
  };
}

function clamp(n, min, max, fb) { return Number.isNaN(n) ? fb : Math.min(max, Math.max(min, n)); }

async function onSaveSite(e) {
  e.preventDefault();
  try {
    const site = collectSiteFromForm();
    if (!site.name) throw new Error('请填写名称');
    if (!/^https?:\/\//i.test(site.url)) throw new Error('请填写有效的 http(s) URL');
    if (!site.checkinProcedureId) throw new Error('请选择自动化技能');
    // 保存任务（可能在任务编辑器里改了但没存——这里不自动存，任务库自己有保存按钮）
    await upsertSite(site);
    try { await chrome.runtime.sendMessage({ type: MSG.RESCHEDULE }); } catch {}
    setFormMsg('已保存', 'ok');
    await reloadAll();
    selectSite(site.id);
  } catch (err) { setFormMsg(err.message || String(err), 'err'); }
}

async function onDeleteSite() {
  if (!currentSiteId) return;
  if (!confirm('确定删除该站点？')) return;
  await removeSite(currentSiteId);
  currentSiteId = null;
  try { await chrome.runtime.sendMessage({ type: MSG.RESCHEDULE }); } catch {}
  await reloadAll();
  setFormMsg('已删除', 'ok');
}

async function onTestSite() {
  try {
    const site = collectSiteFromForm();
    await upsertSite(site);
    currentSiteId = site.id;
    const res = await sendMsg({ type: MSG.RUN_SITE, siteId: site.id, force: true });
    if (!res?.ok) throw new Error(res?.error || '启动失败');
    setFormMsg('已加入执行队列，请查看浏览器标签与日志', 'ok');
  } catch (err) { setFormMsg(err.message || String(err), 'err'); }
}

async function onRunAll() {
  try {
    const res = await sendMsg({ type: MSG.RUN_ALL });
    if (!res?.ok) throw new Error(res?.error || '启动失败');
    alert(`已排队 ${res.queued} 个站点`);
  } catch (e) { alert(e.message || String(e)); }
}

async function onStop() {
  try {
    const res = await sendMsg({ type: 'STOP', reason: '用户强制停止' });
    if (!res?.ok) throw new Error(res?.error || '停止失败');
    alert('已强制停止队列。');
  } catch (e) {
    const msg = e.message || String(e);
    if (/未知消息类型|Receiving end does not exist/i.test(msg)) {
      alert('强制停止失败：请到 chrome://extensions 对本扩展点「重新加载」。\n\n' + msg);
    } else alert(msg);
  }
}

function bindSiteEditor() {
  $('#btnNewSite').addEventListener('click', onNewSite);
  $('#siteForm').addEventListener('submit', onSaveSite);
  $('#btnDeleteSite').addEventListener('click', onDeleteSite);
  $('#btnTestSite').addEventListener('click', onTestSite);
  $('#btnRunAll').addEventListener('click', onRunAll);
  $('#btnStop')?.addEventListener('click', onStop);

  // 实时更新 detail head
  $('#siteForm').addEventListener('input', () => {
    $('#detailTitle').textContent = $('#siteForm').name.value || '未命名站点';
    const u = $('#siteForm').url.value;
    $('#detailUrl').textContent = u;
    $('#detailUrl').href = /^https?:\/\//i.test(u) ? u : '#';
  });
  $('#siteForm').addEventListener('change', () => {
    const site = collectSiteFromForm();
    renderProcPreviews(site);
  });
  $('#btnNewCheckinProc').addEventListener('click', () => createAndSelectProc('checkin'));
  $('#btnEditCheckinProc').addEventListener('click', () => {
    const id = $('#siteForm').checkinProcedureId.value;
    if (id) { switchTab('procedures'); selectProc(id); }
  });
  $('#btnNewLoginProc').addEventListener('click', () => createAndSelectProc('login'));
  $('#btnEditLoginProc').addEventListener('click', () => {
    const id = $('#siteForm').loginProcedureId.value;
    if (id) { switchTab('procedures'); selectProc(id); }
  });
}

async function createAndSelectProc(kind) {
  const proc = createProcedure({ kind, name: kind === 'login' ? '新登录技能' : '新自动化技能' });
  await upsertProcedure(proc);
  await reloadAll();
  switchTab('procedures');
  selectProc(proc.id);
}

function setFormMsg(text, cls = '') {
  const el = $('#formMsg');
  el.textContent = text || '';
  el.className = 'form-msg' + (cls ? ' ' + cls : '');
}

// ===================== 任务库 =====================

function renderProcList() {
  const list = $('#procList');
  list.innerHTML = '';
  let filtered = procedures;
  if (procFilter.kind) filtered = filtered.filter((p) => p.kind === procFilter.kind);
  if (procFilter.q) {
    const q = procFilter.q.toLowerCase();
    filtered = filtered.filter((p) => p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q));
  }
  $('#procCount').textContent = filtered.length;
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-hint compact">暂无任务<br><small>点右上角「新建任务」</small></div>';
    return;
  }
  const refCount = new Map();
  for (const s of sites) {
    if (s.checkinProcedureId) refCount.set(s.checkinProcedureId, (refCount.get(s.checkinProcedureId) || 0) + 1);
    if (s.loginProcedureId) refCount.set(s.loginProcedureId, (refCount.get(s.loginProcedureId) || 0) + 1);
  }
  for (const p of filtered) {
    const el = document.createElement('div');
    el.className = 'proc-card' + (p.id === currentProcId ? ' active' : '');
    const refs = refCount.get(p.id) || 0;
    el.innerHTML = `
      <div class="proc-card-main">
        <span class="kind-tag kind-${p.kind}">${PROCEDURE_KIND_LABEL[p.kind]}</span>
        <span class="proc-name">${escapeHtml(p.name)}</span>
      </div>
      <div class="proc-card-sub">
        ${p.source === 'market' ? `<span class="mini-badge">⬇ ${escapeHtml(p.author || '市场')}</span>` : ''}
        ${refs ? `<span class="mini-badge sched">${refs} 站点引用</span>` : ''}
      </div>
    `;
    el.addEventListener('click', () => selectProc(p.id));
    list.appendChild(el);
  }
}

function selectProc(id) {
  currentProcId = id;
  const proc = procedures.find((p) => p.id === id);
  renderProcList();
  if (!proc) return;
  fillProcForm(proc);
  $('#procEditorEmpty').classList.add('hidden');
  $('#procForm').classList.remove('hidden');
  setProcFormMsg('');
}

function onNewProc(kind = 'checkin') {
  const proc = createProcedure({ kind });
  currentProcId = proc.id;
  procedures = [proc, ...procedures.filter((p) => p.id !== proc.id)];
  fillProcForm(proc);
  renderProcList();
  $('#procEditorEmpty').classList.add('hidden');
  $('#procForm').classList.remove('hidden');
}

function fillProcForm(proc) {
  const form = $('#procForm');
  form.name.value = proc.name || '';
  form.kind.value = proc.kind;
  form.description.value = proc.description || '';
  form.author.value = proc.author || '';
  form.version.value = proc.version || '1.0.0';
  form.homepage.value = proc.homepage || '';
  form.querySelector('[name="procMode"][value="steps"]').checked = proc.steps?.length || !proc.script;
  form.querySelector('[name="procMode"][value="script"]').checked = !proc.steps?.length && !!proc.script;
  form.script.value = proc.script || SCRIPT_TEMPLATE;

  renderProcDetectFields(proc);
  syncProcModeBlocks();

  // 执行结果：最近一次运行结果，放在执行步骤下方
  const lastBody = $('#procLastResultBody');
  const last = proc.lastResult;
  if (lastBody) {
    lastBody.innerHTML = last
      ? `<div class="last-result last-${last.status}">
           <strong>${STATUS_LABEL[last.status] || last.status}</strong> · ${escapeHtml(last.message || '')}
         </div>`
      : '<span class="hint">从未执行过</span>';
  }

  const list = $('#procStepsList');
  list.innerHTML = '';
  for (const step of proc.steps?.length ? proc.steps : (proc.kind === 'login' ? [{ type: 'click', selector: '', timeoutMs: 15000 }] : [{ type: 'click', selector: '.checkin', timeoutMs: 15000 }])) {
    addStepRow(list, step);
  }

  $('#procDetailTitle').textContent = proc.name;
  $('#procDetailMeta').innerHTML = `
    <span class="kind-tag kind-${proc.kind}">${PROCEDURE_KIND_LABEL[proc.kind] || proc.kind}</span>
    ${proc.source === 'market' ? `<span class="mini-badge">市场 · ${escapeHtml(proc.marketId || '')}</span>` : '<span class="mini-badge">本地</span>'}
    ${proc.version ? `v${escapeHtml(proc.version)}` : ''}
  `;
}

function renderProcDetectFields(proc) {
  const body = $('#procDetectBody');
  const d = proc.detect || {};
  if (proc.kind === 'login') {
    $('#procDetectTitle').textContent = '登录状态检测';
    $('#procDetectDesc').textContent = '如何判断已登录、如何识别跳到了登录页';
    body.innerHTML = `
      <div class="grid-2">
        <div class="field">
          <label>已登录标记（CSS / XPath）</label>
          <input name="loggedInSelector" value="${escapeHtml(d.loggedInSelector || '')}" placeholder=".avatar" />
        </div>
        <div class="field">
          <label>已登录 URL 包含</label>
          <input name="loggedInUrlIncludes" value="${escapeHtml(d.loggedInUrlIncludes || '')}" placeholder="/dashboard" />
        </div>
        <div class="field">
          <label>登录页 URL 模式</label>
          <input name="loginUrlPattern" value="${escapeHtml(d.loginUrlPattern || '')}" placeholder="/login  或  /auth\\?/" />
        </div>
        <div class="field">
          <label>未登录关键词（逗号分隔）</label>
          <input name="notLoggedInKeywords" value="${escapeHtml((d.notLoggedInKeywords || []).join(','))}" placeholder="例如：会话已过期,登录后操作" />
        </div>
      </div>
      <p class="hint">执行中若地址命中「登录页 URL 模式」或页面出现「未登录关键词」，扩展会自动中断执行、执行下面的登录步骤，然后重试执行一次。</p>
    `;
  } else {
    $('#procDetectTitle').textContent = '结果判定';
    $('#procDetectDesc').textContent = '根据页面文字判断执行是否成功';
    body.innerHTML = `
      <div class="grid-2">
        <div class="field">
          <label>成功关键词（逗号分隔）</label>
          <input name="successKeywords" value="${escapeHtml((d.successKeywords || []).join(','))}" placeholder="执行成功,已执行" />
        </div>
        <div class="field">
          <label>失败关键词（逗号分隔）</label>
          <input name="failKeywords" value="${escapeHtml((d.failKeywords || []).join(','))}" placeholder="失败,未登录" />
        </div>
      </div>
    `;
  }
}

function syncProcModeBlocks() {
  const mode = $('#procForm [name="procMode"]:checked')?.value || 'steps';
  $('#procStepsBlock').classList.toggle('hidden', mode !== 'steps');
  $('#procScriptBlock').classList.toggle('hidden', mode !== 'script');
}

function collectProcFromForm() {
  const form = $('#procForm');
  const kind = form.kind.value;
  const mode = form.querySelector('[name="procMode"]:checked')?.value || 'steps';
  const existing = procedures.find((p) => p.id === currentProcId) || createProcedure({ id: currentProcId, kind });
  const split = (s) => String(s || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);

  const detect = { ...(existing.detect || {}) };
  if (kind === 'login') {
    detect.loggedInSelector = form.loggedInSelector?.value.trim() || '';
    detect.loggedInUrlIncludes = form.loggedInUrlIncludes?.value.trim() || '';
    detect.loginUrlPattern = form.loginUrlPattern?.value.trim() || '';
    detect.notLoggedInKeywords = split(form.notLoggedInKeywords?.value);
  } else {
    detect.successKeywords = split(form.successKeywords?.value);
    detect.failKeywords = split(form.failKeywords?.value);
  }

  return {
    ...existing,
    id: currentProcId || existing.id,
    kind,
    name: form.name.value.trim() || '未命名任务',
    description: form.description.value.trim(),
    author: form.author.value.trim(),
    version: form.version.value.trim() || '1.0.0',
    homepage: form.homepage.value.trim(),
    detect,
    steps: mode === 'steps' ? collectSteps($('#procStepsList')) : [],
    script: mode === 'script' ? form.script.value : '',
    updatedAt: Date.now(),
  };
}

async function onSaveProc(e) {
  e.preventDefault();
  try {
    const proc = collectProcFromForm();
    if (!proc.name) throw new Error('请填写名称');
    if (proc.kind === 'checkin' && proc.steps.length === 0 && !proc.script) {
      throw new Error('请至少添加一个步骤或填写脚本');
    }
    await upsertProcedure(proc);
    procedures = await getProcedures();
    renderProcList();
    renderProcKindOptions();
    setProcFormMsg('已保存', 'ok');
  } catch (err) { setProcFormMsg(err.message || String(err), 'err'); }
}

async function onDeleteProc() {
  if (!currentProcId) return;
  const refs = sites.filter((s) => s.checkinProcedureId === currentProcId || s.loginProcedureId === currentProcId);
  if (refs.length) {
    if (!confirm(`该任务正被 ${refs.length} 个站点引用，删除后这些站点将无法执行。确定删除？`)) return;
  } else if (!confirm('确定删除该任务？')) return;
  await removeProcedure(currentProcId);
  currentProcId = null;
  await reloadAll();
  setProcFormMsg('已删除', 'ok');
}

async function onDuplicateProc() {
  if (!currentProcId) return;
  const src = procedures.find((p) => p.id === currentProcId);
  if (!src) return;
  const copy = createProcedure({ ...src, id: undefined, name: src.name + ' 副本', source: 'local', marketId: '', createdAt: Date.now() });
  await upsertProcedure(copy);
  await reloadAll();
  selectProc(copy.id);
}

function onExportProc() {
  const proc = collectProcFromForm();
  const payload = {
    spec: 'auto-checkin-procedure/1',
    procedure: { ...proc, id: undefined, source: undefined, installedAt: undefined, marketId: undefined },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `procedure-${proc.kind}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function setProcFormMsg(text, cls = '') {
  const el = $('#procFormMsg');
  el.textContent = text || '';
  el.className = 'form-msg' + (cls ? ' ' + cls : '');
}

function bindProcEditor() {
  $('#btnNewProc').addEventListener('click', () => onNewProc('checkin'));
  $('#procForm').addEventListener('submit', onSaveProc);
  $('#btnDeleteProc').addEventListener('click', onDeleteProc);
  $('#btnDuplicateProc').addEventListener('click', onDuplicateProc);
  $('#btnExportProc').addEventListener('click', onExportProc);
  $('#btnRunProcWatch')?.addEventListener('click', onRunProcWatch);
  $('#btnProcAddStep').addEventListener('click', () => addStepRow($('#procStepsList')));
  $('#btnProcResetScript').addEventListener('click', () => { $('#procForm [name="script"]').value = SCRIPT_TEMPLATE; });
  $('#procKind').addEventListener('change', () => {
    const proc = collectProcFromForm();
    renderProcDetectFields(proc);
  });
  $$('#procForm [name="procMode"]').forEach((r) => r.addEventListener('change', syncProcModeBlocks));
  $('#btnProcToggleHelp')?.addEventListener('click', () => {
    const panel = $('#procStepsHelp');
    panel.open = !panel.open;
  });

  // kind filter
  $$('#procKindSeg .seg-btn').forEach((b) => b.addEventListener('click', () => {
    $$('#procKindSeg .seg-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    procFilter.kind = b.dataset.kind;
    renderProcList();
  }));
  $('#procSearch').addEventListener('input', (e) => { procFilter.q = e.target.value; renderProcList(); });

  // 实时更新标题
  $('#procForm').addEventListener('input', (e) => {
    if (e.target.name === 'name') $('#procDetailTitle').textContent = e.target.value || '任务';
  });
}

// ===================== 市场 =====================

function fillMarketUrl() {
  const el = $('#marketUrl');
  if (el) el.value = settings.marketUrl || '';
}

async function refreshMarket() {
  const root = $('#marketList');
  root.innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    const res = await sendMsg({ type: MSG.MARKET_INDEX });
    if (!res?.ok) throw new Error(res?.error || '加载失败');
    marketIndex = res.index;
    renderMarket();
  } catch (e) {
    root.innerHTML = `<div class="empty-hint">市场加载失败：${escapeHtml(e.message || String(e))}<br><small>可在下方更换市场源 URL</small></div>`;
  }
}

function renderMarket() {
  const root = $('#marketList');
  if (!marketIndex?.items?.length) {
    root.innerHTML = '<div class="empty-hint">市场目录为空</div>';
    return;
  }
  let items = marketIndex.items;
  if (marketFilter.kind) items = items.filter((i) => i.kind === marketFilter.kind);
  if (marketFilter.q) {
    const q = marketFilter.q.toLowerCase();
    items = items.filter((i) => i.name.toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q));
  }
  const installedByMarket = new Map();
  for (const p of procedures) {
    if (p.marketId) installedByMarket.set(p.marketId, p);
  }
  root.innerHTML = items.map((item) => {
    const installed = installedByMarket.get(item.marketId);
    let action = '';
    if (installed) {
      const cmp = compareVersions(item.version, installed.version);
      action = cmp > 0
        ? `<button class="btn btn-sm btn-primary" data-install="${escapeHtml(item.marketId)}">升级到 v${escapeHtml(item.version)}</button>`
        : '<span class="mini-badge sched">已安装</span>';
    } else {
      action = `<button class="btn btn-sm" data-install="${escapeHtml(item.marketId)}">安装</button>`;
    }
    return `
      <div class="market-card">
        <div class="market-card-main">
          <div class="market-card-head">
            <span class="kind-tag kind-${item.kind}">${PROCEDURE_KIND_LABEL[item.kind] || item.kind}</span>
            <strong>${escapeHtml(item.name)}</strong>
            <span class="market-version">v${escapeHtml(item.version)}</span>
          </div>
          <div class="hint">${escapeHtml(item.description || '')}</div>
          <div class="market-meta">
            ${item.author ? `<span>👤 ${escapeHtml(item.author)}</span>` : ''}
            ${item.homepage ? `<a href="${escapeHtml(item.homepage)}" target="_blank" rel="noreferrer">主页</a>` : ''}
          </div>
        </div>
        <div class="market-card-action">${action}</div>
      </div>
    `;
  }).join('');
  root.querySelectorAll('[data-install]').forEach((btn) => {
    btn.addEventListener('click', () => installFromMarket(btn.dataset.install, btn));
  });
}

async function installFromMarket(marketId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '安装中…'; }
  try {
    const res = await sendMsg({ type: MSG.MARKET_INSTALL, marketId });
    if (!res?.ok) throw new Error(res?.error || '安装失败');
    await reloadAll();
    renderMarket();
    alert(res.upgraded ? '已升级到最新版本' : '安装成功');
  } catch (e) {
    alert('安装失败：' + (e.message || String(e)));
    await refreshMarket();
  }
}

function bindMarket() {
  $('#btnRefreshMarket').addEventListener('click', refreshMarket);
  $('#btnSaveMarketUrl').addEventListener('click', async () => {
    const url = $('#marketUrl').value.trim();
    settings = await saveSettings({ marketUrl: url });
    alert('已保存，刷新市场…');
    refreshMarket();
  });
  $$('#marketKindSeg .seg-btn').forEach((b) => b.addEventListener('click', () => {
    $$('#marketKindSeg .seg-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    marketFilter.kind = b.dataset.kind;
    renderMarket();
  }));
  $('#marketSearch').addEventListener('input', (e) => { marketFilter.q = e.target.value; renderMarket(); });
}

// ===================== 流程（画布） =====================

function renderFlowList() {
  const root = $('#flowList');
  if (!root) return;
  if (!flows.length) {
    root.innerHTML = '<div class="empty-hint compact">还没有流程<br><small>点右上角「新建流程」在画布中创建</small></div>';
    return;
  }
  const sorted = [...flows].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  root.innerHTML = sorted.map((f) => {
    const nodeCount = (f.nodes || []).length;
    const edgeCount = (f.edges || []).length;
    const hasStart = (f.nodes || []).some((n) => n.type === 'start');
    const hasEnd = (f.nodes || []).some((n) => n.type === 'end');
    const broken = nodeCount && (!hasStart || !hasEnd);
    const updated = f.updatedAt ? formatTime(f.updatedAt) : '';
    return `
      <div class="flow-card" data-id="${escapeHtml(f.id)}">
        <div class="flow-card-main">
          <div class="flow-card-head">
            <strong class="flow-name">${escapeHtml(f.name || '未命名流程')}</strong>
            ${broken ? '<span class="mini-badge" title="缺少开始或结束节点">⚠ 未完成</span>' : ''}
          </div>
          <div class="flow-card-sub">
            <span>🧩 ${nodeCount} 节点</span>
            <span>🔗 ${edgeCount} 连线</span>
            ${updated ? `<span>🕒 ${escapeHtml(updated)}</span>` : ''}
          </div>
          ${f.description ? `<div class="hint">${escapeHtml(f.description)}</div>` : ''}
        </div>
        <div class="flow-card-actions">
          <button class="btn btn-sm btn-primary" data-flow="open" data-id="${escapeHtml(f.id)}">在画布中编辑</button>
          <button class="btn btn-sm" data-flow="run" data-id="${escapeHtml(f.id)}">▶ 运行</button>
          <button class="btn btn-sm btn-error btn-ghost" data-flow="del" data-id="${escapeHtml(f.id)}">删除</button>
        </div>
      </div>
    `;
  }).join('');

  root.querySelectorAll('button[data-flow]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const action = btn.dataset.flow;
      if (action === 'open') openFlowInCanvas(id);
      else if (action === 'run') runFlow(id);
      else if (action === 'del') removeFlow(id);
    });
  });
  root.querySelectorAll('.flow-card').forEach((card) => {
    card.addEventListener('click', () => openFlowInCanvas(card.dataset.id));
  });
}

function openFlowInCanvas(id) {
  const url = chrome.runtime.getURL(`canvas/index.html?flowId=${encodeURIComponent(id)}`);
  window.open(url, '_blank');
}

async function onCreateFlow() {
  const name = prompt('新流程名称', '新流程');
  if (name === null) return;
  const flow = createFlow({ name: name.trim() || '新流程' });
  await saveFlow(flow);
  await reloadAll();
  openFlowInCanvas(flow.id);
}

async function runFlow(id) {
  // 打开画布并自动运行，执行进度/日志都在画布中可见、可停止
  const url = chrome.runtime.getURL('canvas/index.html') + `?flowId=${encodeURIComponent(id)}&autorun=1`;
  window.open(url, '_blank');
}

async function removeFlow(id) {
  const f = flows.find((x) => x.id === id);
  if (!f) return;
  if (!confirm(`确定删除流程「${f.name}」？此操作不可撤销。`)) return;
  await deleteFlow(id);
  await reloadAll();
}

function bindFlows() {
  $('#btnNewFlow')?.addEventListener('click', onCreateFlow);
  $('#btnOpenCanvas')?.addEventListener('click', () => {
    window.open(chrome.runtime.getURL('canvas/index.html'), '_blank');
  });
  // 存储变化时实时刷新流程列表
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.flows) {
      flows = Array.isArray(changes.flows.newValue) ? changes.flows.newValue : [];
      renderFlowList();
    }
  });
}

// ===================== 日志 =====================

async function renderLogs() {
  const [logs, tasks] = await Promise.all([getLogs(), getTasks()]);
  const root = $('#logTable');
  if (!logs.length && !tasks.length) {
    root.innerHTML = '<div class="empty-hint">暂无日志</div>';
    return;
  }
  const byTask = new Map();
  const legacy = [];
  for (const log of logs) {
    if (log.taskId) {
      if (!byTask.has(log.taskId)) byTask.set(log.taskId, []);
      byTask.get(log.taskId).push(log);
    } else legacy.push(log);
  }
  const taskList = [...tasks].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const orphanIds = [...byTask.keys()].filter((id) => !tasks.some((t) => t.id === id));

  let html = '<div class="task-list">';
  for (const task of taskList) {
    const rows = (byTask.get(task.id) || []).slice().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    html += renderTaskCard(task, rows);
  }
  for (const tid of orphanIds) {
    const rows = byTask.get(tid).slice().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    html += renderTaskCard({
      id: tid, trigger: 'manual', state: 'done',
      startedAt: rows[0]?.startedAt, finishedAt: rows[rows.length - 1]?.finishedAt,
      total: rows.length,
      success: rows.filter((r) => r.status === 'success').length,
      failed: rows.filter((r) => ['failed', 'cf_timeout', 'need_login'].includes(r.status)).length,
      skipped: rows.filter((r) => r.status === 'skipped').length, orphan: true,
    }, rows);
  }
  if (legacy.length) {
    html += `<div class="task-card legacy"><div class="task-head"><div><span class="task-title">历史记录</span><span class="task-sub">升级前单站点日志，共 ${legacy.length} 条</span></div></div>${renderLogTable(legacy.slice().sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0)))}</div>`;
  }
  html += '</div>';
  root.innerHTML = html;
}

function renderTaskCard(task, rows) {
  const triggerLabel = TASK_TRIGGER_LABEL[task.trigger] || '任务';
  const stateLabel = task.state === 'running' ? '运行中' : task.state === 'aborted' ? '已中止' : '已完成';
  const stateCls = task.state === 'running' ? 'running' : task.state === 'aborted' ? 'aborted' : task.failed > 0 ? 'has-fail' : 'ok';
  const started = formatTime(task.startedAt);
  const duration = task.finishedAt && task.startedAt ? formatDuration(task.finishedAt - task.startedAt) : task.state === 'running' ? '进行中…' : '-';
  const chips = [
    `<span class="chip chip-total">共 ${task.total || rows.length}</span>`,
    `<span class="chip chip-ok">成功 ${task.success ?? 0}</span>`,
    task.failed ? `<span class="chip chip-fail">失败 ${task.failed}</span>` : '',
    task.skipped ? `<span class="chip chip-skip">跳过 ${task.skipped}</span>` : '',
  ].filter(Boolean).join('');
  return `<div class="task-card ${stateCls}">
    <div class="task-head">
      <div class="task-head-main">
        <span class="task-title">${escapeHtml(triggerLabel)}</span>
        <span class="task-state state-${stateCls}">${stateLabel}</span>
        ${task.orphan ? '<span class="task-state state-aborted">未归档</span>' : ''}
      </div>
      <div class="task-head-meta">
        <span class="task-time">开始 ${escapeHtml(started)}</span>
        <span class="task-dur">耗时 ${escapeHtml(duration)}</span>
        ${chips}
      </div>
    </div>
    ${renderLogTable(rows)}
  </div>`;
}

function renderLogTable(rows) {
  if (!rows.length) return '<div class="empty-hint compact">本任务无站点记录</div>';
  const body = rows.map((log) => `<tr>
    <td class="col-time">${escapeHtml(formatTime(log.finishedAt || log.startedAt))}</td>
    <td class="col-site">${escapeHtml(log.siteName || log.siteId)}</td>
    <td class="col-status"><span class="${RUN_STATUS_BADGE[log.status] || 'badge'}">${escapeHtml(STATUS_LABEL[log.status] || log.status)}</span></td>
    <td class="col-msg">${escapeHtml(log.message || '')}</td>
    <td class="col-cf">${log.cfWaitedMs ? log.cfWaitedMs + 'ms' : '-'}</td>
  </tr>`).join('');
  return `<div class="log-scroll"><table class="task-table">
    <thead><tr><th class="col-time">时间</th><th class="col-site">站点</th><th class="col-status">状态</th><th class="col-msg">消息</th><th class="col-cf">CF 等待</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `${m} 分 ${rs} 秒`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

async function onClearLogs() {
  if (!confirm('确定清空全部日志？')) return;
  await clearLogs();
  await renderLogs();
}

// ===================== 设置 / 导入导出 =====================

async function loadSettingsForm() {
  const s = await getSettings();
  settings = s;
  const form = $('#settingsForm');
  form.notifyOnComplete.checked = s.notifyOnComplete !== false;
  form.notifyOnError.checked = s.notifyOnError !== false;
  form.openInBackground.checked = s.openInBackground !== false;
  form.siteGapMs.value = s.siteGapMs ?? 2000;
  form.maxLogs.value = s.maxLogs ?? 200;
  form.defaultCfTimeoutMs.value = s.defaultCfTimeoutMs ?? 90000;
  form.cfManualGraceMs.value = s.cfManualGraceMs ?? 120000;
  if (form.llmProvider) form.llmProvider.value = s.llmProvider || 'anthropic';
  if (form.llmModel) form.llmModel.value = s.llmModel || '';
  if (form.llmApiKey) form.llmApiKey.value = s.llmApiKey || '';
  if (form.llmBaseUrl) form.llmBaseUrl.value = s.llmBaseUrl || '';
  if (form.llmHeaders) form.llmHeaders.value = s.llmHeaders || '';
  renderHeaderPreview();
  fillMarketUrl();
}

async function onSaveSettings(e) {
  e.preventDefault();
  settings = await saveSettings(collectSettingsForm());
  const msg = $('#settingsMsg');
  msg.textContent = '设置已保存';
  msg.className = 'form-msg ok';
}

function collectSettingsForm() {
  const form = $('#settingsForm');
  return {
    notifyOnComplete: form.notifyOnComplete.checked,
    notifyOnError: form.notifyOnError.checked,
    openInBackground: form.openInBackground.checked,
    siteGapMs: Number(form.siteGapMs.value) || 0,
    maxLogs: Number(form.maxLogs.value) || 200,
    defaultCfTimeoutMs: Number(form.defaultCfTimeoutMs.value) || 90000,
    cfManualGraceMs: Number(form.cfManualGraceMs.value) || 0,
    llmProvider: form.llmProvider?.value || 'anthropic',
    llmModel: form.llmModel?.value.trim() || '',
    llmApiKey: form.llmApiKey?.value.trim() || '',
    llmBaseUrl: form.llmBaseUrl?.value.trim() || '',
    llmHeaders: form.llmHeaders?.value.trim() || '',
  };
}

function collectLlmFormConfig() {
  const form = $('#settingsForm');
  return {
    provider: form.llmProvider?.value || 'anthropic',
    apiKey: form.llmApiKey?.value.trim() || '',
    baseUrl: form.llmBaseUrl?.value.trim() || '',
    model: form.llmModel?.value.trim() || '',
    headers: form.llmHeaders?.value.trim() || '',
  };
}

async function onExport() {
  const data = await exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pagedrone-export-${dateStamp()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  $('#ioMsg').textContent = '导出完成';
  $('#ioMsg').className = 'form-msg ok';
}

async function onImport() {
  const file = $('#importFile').files?.[0];
  if (!file) { $('#ioMsg').textContent = '请先选择文件'; $('#ioMsg').className = 'form-msg err'; return; }
  try {
    const data = JSON.parse(await file.text());
    await importSites(data, { merge: !$('#importReplace').checked });
    try { await chrome.runtime.sendMessage({ type: MSG.RESCHEDULE }); } catch {}
    await reloadAll();
    $('#ioMsg').textContent = '导入成功';
    $('#ioMsg').className = 'form-msg ok';
  } catch (e) {
    $('#ioMsg').textContent = e.message || String(e);
    $('#ioMsg').className = 'form-msg err';
  }
}

function bindSettingsAndIo() {
  $('#settingsForm').addEventListener('submit', onSaveSettings);
  $('#btnClearLogs').addEventListener('click', onClearLogs);
  $('#btnExport').addEventListener('click', onExport);
  $('#btnImport').addEventListener('click', onImport);
  bindAiSettings();
}

// ===================== AI 设置 =====================

function bindAiSettings() {
  // 改动任一影响请求头的字段都实时重算预览，让用户看到覆盖/删除的实际效果
  for (const sel of ['#llmProvider', '#llmHeaders', '[name="llmApiKey"]']) {
    const el = $(sel);
    if (el) el.addEventListener('input', renderHeaderPreview);
  }
  $('#llmProvider')?.addEventListener('change', renderHeaderPreview);
  $('#btnFetchModels')?.addEventListener('click', onFetchModels);
  $('#btnTestLlm')?.addEventListener('click', onTestLlm);

  const input = $('#llmModel');
  const combo = $('#llmModelCombobox');
  input?.addEventListener('input', () => {
    llmModelShowAll = false;
    llmModelActiveIndex = -1;
    if (llmModels.length) openLlmModelMenu(false);
  });
  input?.addEventListener('click', () => {
    if (llmModels.length) openLlmModelMenu(true);
  });
  input?.addEventListener('keydown', onLlmModelKeydown);
  $('#btnToggleModels')?.addEventListener('click', () => {
    const menu = $('#llmModelMenu');
    if (menu?.classList.contains('hidden')) openLlmModelMenu(true);
    else closeLlmModelMenu();
  });
  document.addEventListener('pointerdown', (event) => {
    if (combo && !combo.contains(event.target)) closeLlmModelMenu();
  });
}

function filteredLlmModels() {
  const query = $('#llmModel')?.value.trim().toLowerCase() || '';
  if (llmModelShowAll || !query) return llmModels;
  return llmModels.filter((id) => id.toLowerCase().includes(query));
}

function renderLlmModelMenu() {
  const menu = $('#llmModelMenu');
  const input = $('#llmModel');
  if (!menu || !input) return;
  const matches = filteredLlmModels().slice(0, 200);
  menu.replaceChildren();

  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'llm-model-empty';
    empty.textContent = llmModels.length ? '没有匹配的模型，可继续手动输入' : '请先点击“获取模型”';
    menu.appendChild(empty);
    llmModelActiveIndex = -1;
    input.removeAttribute('aria-activedescendant');
    return;
  }

  if (llmModelActiveIndex >= matches.length) llmModelActiveIndex = matches.length - 1;
  matches.forEach((id, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.id = `llm-model-option-${index}`;
    option.className = 'llm-model-option' + (index === llmModelActiveIndex ? ' active' : '');
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(input.value === id));
    option.textContent = id;
    option.addEventListener('pointerdown', (event) => event.preventDefault());
    option.addEventListener('click', () => selectLlmModel(id));
    menu.appendChild(option);
  });

  if (llmModelActiveIndex >= 0) {
    input.setAttribute('aria-activedescendant', `llm-model-option-${llmModelActiveIndex}`);
  } else {
    input.removeAttribute('aria-activedescendant');
  }
}

function openLlmModelMenu(showAll) {
  if (!llmModels.length) return;
  llmModelShowAll = showAll;
  const menu = $('#llmModelMenu');
  const input = $('#llmModel');
  menu?.classList.remove('hidden');
  input?.setAttribute('aria-expanded', 'true');
  renderLlmModelMenu();
}

function closeLlmModelMenu() {
  $('#llmModelMenu')?.classList.add('hidden');
  $('#llmModel')?.setAttribute('aria-expanded', 'false');
  $('#llmModel')?.removeAttribute('aria-activedescendant');
  llmModelActiveIndex = -1;
}

function selectLlmModel(id) {
  const input = $('#llmModel');
  if (!input) return;
  input.value = id;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  closeLlmModelMenu();
  input.focus();
}

function onLlmModelKeydown(event) {
  if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
  const menu = $('#llmModelMenu');
  const isOpen = menu && !menu.classList.contains('hidden');
  if (event.key === 'Escape') {
    closeLlmModelMenu();
    return;
  }
  if (!llmModels.length) return;
  if (!isOpen) {
    event.preventDefault();
    openLlmModelMenu(true);
    return;
  }

  const matches = filteredLlmModels().slice(0, 200);
  if (event.key === 'Enter') {
    if (llmModelActiveIndex >= 0 && matches[llmModelActiveIndex]) {
      event.preventDefault();
      selectLlmModel(matches[llmModelActiveIndex]);
    }
    return;
  }

  event.preventDefault();
  const delta = event.key === 'ArrowDown' ? 1 : -1;
  llmModelActiveIndex = Math.max(0, Math.min(matches.length - 1, llmModelActiveIndex + delta));
  renderLlmModelMenu();
  menu?.querySelector('.llm-model-option.active')?.scrollIntoView({ block: 'nearest' });
}

/** 与 lib/llm.js 的 defaultLlmHeaders 保持一致（此处仅用于界面预览） */
function defaultLlmHeaders(provider, apiKey) {
  if (provider === 'openai') {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  }
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

function parseHeaderText(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf(':');
    if (i <= 0) continue;
    const name = s.slice(0, i).trim();
    if (name) out[name] = s.slice(i + 1).trim();
  }
  return out;
}

function maskKey(key) {
  const k = String(key || '');
  if (!k) return '(未填写 API Key)';
  if (k.length <= 12) return `${k.slice(0, 2)}****`;
  return `${k.slice(0, 7)}****${k.slice(-4)}`;
}

/**
 * 渲染「默认值 + 你的覆盖」后实际发出的请求头。
 * API Key 打码后展示——设置页可能在录屏或旁人在场时打开。
 */
function renderHeaderPreview() {
  const pre = $('#llmHeaderPreview');
  if (!pre) return;
  const form = $('#settingsForm');
  const provider = form?.llmProvider?.value || 'anthropic';
  const apiKey = form?.llmApiKey?.value.trim() || '';
  const custom = parseHeaderText(form?.llmHeaders?.value || '');

  const merged = defaultLlmHeaders(provider, maskKey(apiKey));
  const notes = [];
  for (const [name, rawValue] of Object.entries(custom)) {
    const existing = Object.keys(merged).find((k) => k.toLowerCase() === name.toLowerCase());
    if (existing) delete merged[existing];
    if (rawValue === '') {
      notes.push(`（已删除默认头 ${name}）`);
    } else {
      merged[name] = rawValue.replace(/\{\{\s*apiKey\s*\}\}/g, maskKey(apiKey));
      if (existing) notes.push(`（已覆盖默认头 ${existing}）`);
    }
  }
  const lines = Object.entries(merged).map(([k, v]) => `${k}: ${v}`);
  pre.textContent = [...lines, ...notes].join('\n') || '（无请求头）';
}

async function onFetchModels() {
  const btn = $('#btnFetchModels');
  const msg = $('#llmTestMsg');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '获取中…';
  msg.textContent = '';
  msg.className = 'form-msg';
  try {
    const config = collectLlmFormConfig();
    if (!config.apiKey) throw new Error('请先填写 API Key（无需先保存）');
    const resp = await chrome.runtime.sendMessage({ type: MSG.LLM_MODELS, config });
    if (!resp?.ok) throw new Error(resp?.error || '获取失败');
    llmModels = [...new Set((resp.models || []).map(String).filter(Boolean))];
    llmModelActiveIndex = -1;
    msg.textContent = llmModels.length
      ? `已获取 ${llmModels.length} 个模型，可点击输入框或右侧箭头选择`
      : '接口未返回任何模型，请手动填写模型名';
    msg.className = llmModels.length ? 'form-msg ok' : 'form-msg';
    if (llmModels.length) {
      $('#llmModel')?.focus();
      openLlmModelMenu(true);
    }
  } catch (e) {
    msg.textContent = `获取模型失败：${e.message || e}`;
    msg.className = 'form-msg err';
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function onTestLlm() {
  const btn = $('#btnTestLlm');
  const msg = $('#llmTestMsg');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '测试中…';
  msg.textContent = '正在发送测试消息…';
  msg.className = 'form-msg';
  try {
    const prompt = $('#llmTestPrompt')?.value.trim() || '';
    const resp = await chrome.runtime.sendMessage({ type: MSG.LLM_TEST, prompt });
    if (!resp?.ok) throw new Error(resp?.error || '测试失败');
    msg.textContent = `✓ ${resp.message}`;
    msg.className = 'form-msg ok';
  } catch (e) {
    msg.textContent = `✗ ${e.message || e}`;
    msg.className = 'form-msg err';
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ===================== 智能代理（对话式） =====================

let agentBusy = false;
let agentPollTimer = null;

function bindAgentChat() {
  $('#btnAgentSend')?.addEventListener('click', onAgentSend);
  $('#btnAgentAbort')?.addEventListener('click', onAgentAbort);
  $('#btnAgentReset')?.addEventListener('click', onAgentReset);
  // Ctrl/Cmd+Enter 发送：输入框是多行的，直接回车要留给换行
  $('#agentInput')?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      onAgentSend();
    }
  });
  void refreshAgentHistory();
}

async function refreshAgentHistory() {
  try {
    const resp = await sendMsg({ type: MSG.AGENT_CHAT_HISTORY });
    if (resp?.ok) {
      renderAgentTurns(resp.turns || []);
      setAgentBusy(!!resp.busy);
    }
  } catch {
    /* 后台未就绪时静默：用户发消息时会拿到明确报错 */
  }
}

function setAgentBusy(busy) {
  agentBusy = busy;
  const send = $('#btnAgentSend');
  const abort = $('#btnAgentAbort');
  if (send) {
    send.disabled = busy;
    send.textContent = busy ? '处理中…' : '发送';
  }
  if (abort) abort.disabled = !busy;
  $('#agentProgress').hidden = !busy;
}

async function onAgentSend() {
  if (agentBusy) return;
  const input = $('#agentInput');
  const text = input?.value.trim();
  if (!text) return;
  if (!settings.llmApiKey) {
    if (confirm('尚未配置大模型 API Key，是否前往「全局设置」填写？')) switchTab('settings');
    return;
  }

  input.value = '';
  // 先本地渲染用户气泡，不等后台回包——否则输入到显示之间会有明显空档
  appendAgentBubble({ role: 'user', text, at: Date.now() });
  setAgentBusy(true);
  setAgentProgress('已发送，代理正在思考…');

  try {
    const resp = await sendMsg({ type: MSG.AGENT_CHAT_SEND, text });
    if (!resp?.ok) throw new Error(resp?.error || '发送失败');
    startAgentPolling();
  } catch (e) {
    setAgentBusy(false);
    appendAgentBubble({ role: 'agent', text: `✗ ${e.message || e}`, at: Date.now(), error: true });
  }
}

async function onAgentAbort() {
  try {
    await sendMsg({ type: MSG.AGENT_CHAT_ABORT });
    setAgentProgress('已请求停止…');
  } catch (e) {
    alert('停止失败：' + (e.message || String(e)));
  }
}

async function onAgentReset() {
  if (agentBusy && !confirm('代理正在处理中，确定清空对话吗？')) return;
  try {
    await sendMsg({ type: MSG.AGENT_CHAT_RESET });
  } catch {
    /* 后台没起来也让前端清干净 */
  }
  stopAgentPolling();
  setAgentBusy(false);
  $('#agentMessages').textContent = '';
  renderAgentEmpty();
}

/**
 * 轮询后台进度。代理跑完（agentResult 出现）后拉一次完整历史，
 * 并刷新任务/站点列表——代理很可能刚创建了新对象。
 */
function startAgentPolling() {
  stopAgentPolling();
  agentPollTimer = setInterval(async () => {
    let runtime;
    try {
      const resp = await sendMsg({ type: MSG.GET_STATUS });
      if (!resp?.ok) return;
      runtime = resp.runtime || {};
    } catch {
      return;
    }

    if (runtime.agentProgress?.message) setAgentProgress(runtime.agentProgress.message);

    if (runtime.agentResult) {
      stopAgentPolling();
      setAgentBusy(false);
      await refreshAgentHistory();
      // 代理写入的任务/站点/流程要立刻反映到其他 tab
      await reloadAll();
    }
  }, 1200);
}

function stopAgentPolling() {
  if (agentPollTimer) {
    clearInterval(agentPollTimer);
    agentPollTimer = null;
  }
}

function setAgentProgress(message) {
  const el = $('#agentProgress');
  if (!el) return;
  el.hidden = false;
  el.textContent = `⏳ ${message}`;
}

function renderAgentEmpty() {
  const box = $('#agentMessages');
  if (!box || box.children.length) return;
  const el = document.createElement('div');
  el.className = 'chat-empty';
  el.textContent = '还没有对话。描述你想要的自动化，例如「帮我看看 example.com 上有哪些按钮」。';
  box.appendChild(el);
}

function renderAgentTurns(turns) {
  const box = $('#agentMessages');
  if (!box) return;
  box.textContent = '';
  if (!turns.length) {
    renderAgentEmpty();
    return;
  }
  for (const t of turns) appendAgentBubble(t);
}

/**
 * 渲染一条消息气泡。
 * 全程用 textContent 而非 innerHTML：内容里混有模型输出和抓来的页面正文，
 * 直接插 HTML 就是现成的 XSS 入口。
 */
function appendAgentBubble(turn) {
  const box = $('#agentMessages');
  if (!box) return;
  $('.chat-empty', box)?.remove();

  const wrap = document.createElement('div');
  wrap.className = `chat-bubble ${turn.role}${turn.error ? ' err' : ''}`;

  const head = document.createElement('div');
  head.className = 'chat-bubble-head';
  head.textContent = turn.role === 'user' ? '你' : '智能代理';
  wrap.appendChild(head);

  const body = document.createElement('div');
  body.className = 'chat-bubble-body';
  body.textContent = turn.text || '';
  wrap.appendChild(body);

  // AI 工具调用轨迹：默认折叠，展开后能看到代理到底做了什么、参数是什么
  if (turn.traces?.length) {
    const details = document.createElement('details');
    details.className = 'chat-traces';
    const summary = document.createElement('summary');
    const okCount = turn.traces.filter((t) => t.ok).length;
    summary.textContent = `调用了 ${turn.traces.length} 个技能（成功 ${okCount}）`;
    details.appendChild(summary);
    for (const tr of turn.traces) {
      const row = document.createElement('div');
      row.className = `chat-trace ${tr.ok ? 'ok' : 'err'}`;
      const name = document.createElement('div');
      name.className = 'chat-trace-name';
      name.textContent = `${tr.ok ? '✓' : '✗'} ${tr.skill}`;
      row.appendChild(name);
      if (tr.thought) {
        const th = document.createElement('div');
        th.className = 'chat-trace-thought';
        th.textContent = tr.thought;
        row.appendChild(th);
      }
      const detail = document.createElement('pre');
      detail.className = 'chat-trace-detail';
      detail.textContent = `参数：${JSON.stringify(tr.args)}\n结果：${tr.summary}`;
      row.appendChild(detail);
      details.appendChild(row);
    }
    wrap.appendChild(details);
  }

  // 本轮创建/改动的实体，点一下直接跳过去看
  if (turn.touched?.length) {
    const seen = new Set();
    const links = document.createElement('div');
    links.className = 'chat-touched';
    for (const item of turn.touched) {
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip-link';
      const label = item.kind === 'procedure' ? '任务' : item.kind === 'site' ? '站点' : '流程';
      btn.textContent = `${label}：${item.name}`;
      btn.addEventListener('click', () => gotoTouched(item));
      links.appendChild(btn);
    }
    if (links.children.length) wrap.appendChild(links);
  }

  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
}

function gotoTouched(item) {
  if (item.kind === 'procedure') {
    switchTab('procedures');
    selectProc(item.id);
  } else if (item.kind === 'site') {
    switchTab('sites');
    selectSite(item.id);
  } else {
    switchTab('flows');
  }
}

// ===================== AI 探索生成 =====================

let exploring = false;

function bindExplore() {
  $('#btnExploreGenerate')?.addEventListener('click', () => {
    if (!settings.llmApiKey) {
      if (confirm('尚未配置大模型 API Key，是否前往「全局设置」填写？')) switchTab('settings');
      return;
    }
    resetExploreDialog();
    $('#dlgExplore').showModal();
  });
  $('#btnStartExplore')?.addEventListener('click', startExploration);
  $('#btnAbortExplore')?.addEventListener('click', async () => {
    await sendMsg({ type: MSG.EXPLORE_ABORT });
    appendExploreLog('⏹ 已请求停止探索…');
  });
  $('#btnCloseExplore')?.addEventListener('click', () => $('#dlgExplore').close());
}

function resetExploreDialog() {
  $('#exploreLog').textContent = '等待开始…';
  $('#btnStartExplore').classList.remove('hidden');
  $('#btnAbortExplore').classList.add('hidden');
  exploring = false;
}

function appendExploreLog(line) {
  const el = $('#exploreLog');
  if (el.textContent === '等待开始…') el.textContent = '';
  el.textContent += (el.textContent ? '\n' : '') + line;
  el.scrollTop = el.scrollHeight;
}

async function startExploration() {
  const url = $('#exploreUrl').value.trim();
  const goal = $('#exploreGoal').value.trim();
  const successKws = $('#exploreSuccessKws').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (!url || !goal) { alert('请填写目标网址和目标描述'); return; }

  exploring = true;
  $('#btnStartExplore').classList.add('hidden');
  $('#btnAbortExplore').classList.remove('hidden');
  $('#exploreLog').textContent = '正在启动探索，打开目标页…';

  try {
    await sendMsg({ type: MSG.EXPLORE_GENERATE, url, goal, successKws });
    pollExplorationProgress();
  } catch (e) {
    appendExploreLog('❌ 启动失败：' + (e.message || String(e)));
    resetExploreDialog();
  }
}

let _lastExploreProgressAt = 0;

async function pollExplorationProgress() {
  if (!exploring) return;
  let status;
  try {
    status = await sendMsg({ type: MSG.GET_STATUS });
  } catch {
    setTimeout(pollExplorationProgress, 1200);
    return;
  }
  const rt = status.runtime || {};

  const p = rt.explorationProgress;
  if (p && p.at && p.at !== _lastExploreProgressAt) {
    _lastExploreProgressAt = p.at;
    let line = `[${p.step || '?'}/${p.total || '?'}]`;
    if (p.action) line += ` ${p.action}`;
    if (p.reason) line += ` — ${p.reason}`;
    if (p.message) line += ` ${p.message}`;
    appendExploreLog(line);
  }

  if (rt.explorationResult) {
    const r = rt.explorationResult;
    exploring = false;
    if (r.ok) {
      appendExploreLog(`✅ 探索成功：已生成 ${r.steps ?? ''} 个步骤`);
      await reloadAll();
      if (r.procId) { switchTab('procedures'); selectProc(r.procId); }
      setTimeout(() => $('#dlgExplore').close(), 800);
    } else {
      appendExploreLog('❌ 探索失败：' + (r.message || '未知原因'));
    }
    resetExploreDialogButtonsOnly();
    return;
  }

  if (rt.state === RUN_STATE.EXPLORING) {
    setTimeout(pollExplorationProgress, 1200);
  } else {
    // 状态已回 idle 但还没结果，多等一轮
    setTimeout(pollExplorationProgress, 1200);
  }
}

function resetExploreDialogButtonsOnly() {
  $('#btnStartExplore').classList.remove('hidden');
  $('#btnAbortExplore').classList.add('hidden');
}

// ===================== 录制生成任务 =====================

let recording = false;
let _lastRecordCount = -1;

function bindRecord() {
  $('#btnRecordGenerate')?.addEventListener('click', () => {
    resetRecordDialog();
    $('#dlgRecord').showModal();
  });
  $('#btnStartRecord')?.addEventListener('click', startRecording);
  $('#btnStopRecord')?.addEventListener('click', stopRecording);
  $('#btnCloseRecord')?.addEventListener('click', async () => {
    // 录制中，或已中断但仍有待保存的步骤 → 关闭意味着丢弃，需确认
    const hasUnsaved = recording || _lastRecordCount > 0;
    if (hasUnsaved) {
      if (!confirm('本次录制尚未保存，关闭将丢弃，确定吗？')) return;
      recording = false;
      try { await sendMsg({ type: MSG.RECORD_DISCARD }); } catch { /* ignore */ }
    }
    $('#dlgRecord').close();
  });
  // 点击步骤列表里的删除按钮
  $('#recordSteps')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.rec-del');
    if (!btn) return;
    const idx = Number(btn.dataset.index);
    if (Number.isNaN(idx)) return;
    try { await sendMsg({ type: MSG.RECORD_STEP_REMOVE, index: idx }); } catch { /* ignore */ }
  });
}

function resetRecordDialog() {
  recording = false;
  _lastRecordCount = -1;
  $('#recordSteps').innerHTML = '<span class="hint">开始后，你的操作会在这里逐条出现…</span>';
  $('#recordCount').textContent = '0';
  setRecordHint('');
  $('#btnStartRecord').classList.remove('hidden');
  $('#btnStopRecord').classList.add('hidden');
}

async function startRecording() {
  const url = $('#recordUrl').value.trim();
  if (!url) { alert('请填写目标网址'); return; }
  $('#btnStartRecord').classList.add('hidden');
  try {
    await sendMsg({ type: MSG.RECORD_START, url });
    recording = true;
    $('#btnStopRecord').classList.remove('hidden');
    $('#recordSteps').innerHTML = '<span class="hint">录制中…请切到刚打开的页面操作</span>';
    pollRecording();
  } catch (e) {
    $('#btnStartRecord').classList.remove('hidden');
    alert('启动录制失败：' + (e.message || String(e)));
  }
}

async function pollRecording() {
  if (!recording) return;
  let status;
  try {
    status = await sendMsg({ type: MSG.GET_STATUS });
  } catch {
    setTimeout(pollRecording, 1000);
    return;
  }
  const rt = status.runtime || {};
  const steps = Array.isArray(rt.recordingSteps) ? rt.recordingSteps : [];
  if (steps.length !== _lastRecordCount) {
    _lastRecordCount = steps.length;
    renderRecordSteps(steps);
  }
  // 标签被关闭等外部停止：SW 会把 state 复位并写 recordingResult。
  // 此时会话已结束，但步骤仍暂存在后台，「停止并保存」依然可用——
  // 所以只停轮询，不隐藏保存按钮。
  if (rt.state !== RUN_STATE.RECORDING && rt.recordingResult) {
    recording = false;
    if (rt.recordingResult.pending) {
      const n = rt.recordingResult.steps || 0;
      setRecordHint(`录制已中断（${rt.recordingResult.reason || '外部停止'}），${n} 个步骤待保存 —— 点「停止并保存」生成任务`);
    }
    return;
  }
  setTimeout(pollRecording, 1000);
}

/** 在步骤列表上方显示一行提示（不覆盖已渲染的步骤） */
function setRecordHint(text) {
  let el = $('#recordHint');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

function renderRecordSteps(steps) {
  $('#recordCount').textContent = String(steps.length);
  if (!steps.length) {
    $('#recordSteps').innerHTML = '<span class="hint">录制中…请切到刚打开的页面操作</span>';
    return;
  }
  const html = steps
    .map(
      (s) =>
        `<div class="rec-item"><span class="rec-idx">${s.index + 1}</span>` +
        `<span class="rec-type">${escapeHtml(s.type)}</span>` +
        `<span class="rec-label">${escapeHtml(s.label || '')}</span>` +
        `<button class="rec-del" data-index="${s.index}" title="删除此步">✕</button></div>`
    )
    .join('');
  $('#recordSteps').innerHTML = html;
}

async function stopRecording() {
  const url = $('#recordUrl').value.trim();
  const name = $('#recordName').value.trim();
  const successKws = $('#recordSuccessKws').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  recording = false;
  $('#btnStopRecord').disabled = true;
  try {
    const res = await sendMsg({ type: MSG.RECORD_STOP, url, name, successKws });
    if (res && res.ok && res.procId) {
      await reloadAll();
      switchTab('procedures');
      selectProc(res.procId);
      $('#dlgRecord').close();
    } else {
      alert('未生成任务：' + (res?.message || '请至少在页面上操作一次'));
      resetRecordDialog();
    }
  } catch (e) {
    alert('保存录制失败：' + (e.message || String(e)));
    resetRecordDialog();
  } finally {
    $('#btnStopRecord').disabled = false;
  }
}

// ===================== 执行偏差介入 =====================

let currentIntervention = null;

async function onRunProcWatch() {
  if (!currentProcId) return;
  // 先保存当前编辑，确保执行的是最新步骤
  try {
    const proc = collectProcFromForm();
    await upsertProcedure(proc);
    procedures = await getProcedures();
  } catch (e) {
    setProcFormMsg(e.message || String(e), 'err');
    return;
  }
  setProcFormMsg('已启动试运行，若某步失败会在下方弹出介入面板…', 'ok');
  try {
    // 不 await 完成（执行中可能挂起等待介入）；结果由轮询 + 面板反映
    sendMsg({ type: MSG.RUN_PROCEDURE, procedureId: currentProcId, watchDeviation: true })
      .then((res) => {
        if (res && res.ok === false && !currentIntervention) {
          setProcFormMsg('试运行结束：' + (res.message || res.error || '失败'), 'err');
        } else if (res && res.ok) {
          setProcFormMsg('试运行成功：' + (res.message || ''), 'ok');
        }
      })
      .catch((e) => setProcFormMsg('试运行出错：' + (e.message || String(e)), 'err'));
  } catch (e) {
    setProcFormMsg('试运行启动失败：' + (e.message || String(e)), 'err');
  }
}

function bindIntervention() {
  $('#btnItvRetry')?.addEventListener('click', () => resolveItv('retry'));
  $('#btnItvSkip')?.addEventListener('click', () => resolveItv('skip'));
  $('#btnItvAbort')?.addEventListener('click', () => resolveItv('abort'));
  $('#btnItvPatch')?.addEventListener('click', () => {
    const sel = $('#interventionPatchSelector').value.trim();
    if (!sel) { alert('请填写新的选择器'); return; }
    const patchStep = { ...(currentIntervention?.step || {}), selector: sel };
    resolveItv('patch', patchStep);
  });
}

async function pollInterventionState() {
  let status;
  try {
    status = await sendMsg({ type: MSG.GET_STATUS });
  } catch {
    return;
  }
  const rt = status.runtime || {};
  if (rt.state === RUN_STATE.NEED_INTERVENTION && rt.intervention) {
    showInterventionPanel(rt.intervention);
  } else {
    hideInterventionPanel();
  }
}

function showInterventionPanel(itv) {
  // 同一 token 已展示则不重复刷新（避免用户输入被清空）
  if (currentIntervention && currentIntervention.token === itv.token) return;
  currentIntervention = itv;
  const panel = $('#interventionPanel');
  panel.classList.remove('hidden');
  $('#interventionDesc').textContent = itv.error || '步骤执行失败';
  $('#itvStepType').textContent = itv.step?.type || '(未知)';
  $('#itvStepSelector').textContent = itv.step?.selector || itv.step?.url || itv.step?.includes || '(无)';
  // 仅对有选择器的步骤显示「修复选择器」
  const canPatch = itv.step && ('selector' in itv.step);
  $('#interventionPatchRow').classList.toggle('hidden', !canPatch);
  $('#interventionPatchSelector').value = itv.step?.selector || '';
  // 若当前不在任务库标签，跳过去让用户看到
  if (!$$('#tab-procedures.active').length) switchTab('procedures');
}

function hideInterventionPanel() {
  if (!currentIntervention) return;
  currentIntervention = null;
  $('#interventionPanel')?.classList.add('hidden');
}

async function resolveItv(action, patchStep) {
  if (!currentIntervention) return;
  const token = currentIntervention.token;
  try {
    await sendMsg({ type: MSG.INTERVENTION_RESOLVE, token, action, patchStep });
  } catch (e) {
    alert('提交介入决策失败：' + (e.message || String(e)));
    return;
  }
  hideInterventionPanel();
}

// ===================== 工具 =====================

async function sendMsg(msg) {
  try { return await chrome.runtime.sendMessage(msg); }
  catch (e) {
    const m = e?.message || String(e);
    if (/Receiving end does not exist|Could not establish connection/i.test(m)) {
      throw new Error('后台未启动：请到 chrome://extensions 点击本扩展的「重新加载」');
    }
    throw e;
  }
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function dateStamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
