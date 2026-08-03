import { MSG } from '../lib/messaging.js';
import {
  createSite,
  createProcedure,
  SCRIPT_TEMPLATE,
  STATUS_LABEL,
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
import { compareVersions } from '../lib/market.js';
import { addStepRow, collectSteps, renumberSteps, STEP_UI } from './step-editor.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let sites = [];
let procedures = [];
let settings = {};
let currentSiteId = null;
let currentProcId = null;
let procFilter = { kind: '', q: '' };
let marketFilter = { kind: '', q: '' };
let marketIndex = null;

init();

async function init() {
  loadVersion();
  bindNav();
  bindSiteEditor();
  bindProcEditor();
  bindMarket();
  bindSettingsAndIo();

  await reloadAll();

  // 自动刷新
  setInterval(async () => {
    if ($$('#tab-logs.active').length) await renderLogs();
  }, 3000);
}

function bindNav() {
  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

async function reloadAll() {
  [sites, procedures, settings] = await Promise.all([
    getSites(),
    getProcedures(),
    getSettings(),
  ]);
  renderSiteList();
  renderProcList();
  renderProcKindOptions();
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
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
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
      <span class="status-dot ${dotCls}" title="${st ? STATUS_LABEL[st] || st : '未签到'}"></span>
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
  // 自动创建一个默认签到流程并绑定
  const proc = createProcedure({ kind: 'checkin', name: '新签到流程' });
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
  setFormMsg('请填写后点击保存（已自动创建默认签到流程）', '');
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
    lastEl.textContent = '尚未签到';
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
  checkinSel.innerHTML = checkins.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}${p.source === 'market' ? '  ⬇' : ''}</option>`).join('') || '<option value="">（请先到流程库新建）</option>';
  if (curC && checkins.some((p) => p.id === curC)) checkinSel.value = curC;
  loginSel.innerHTML = '<option value="">（不使用登录流程）</option>' + logins.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}${p.source === 'market' ? '  ⬇' : ''}</option>`).join('');
  if (curL && logins.some((p) => p.id === curL)) loginSel.value = curL;
}

function renderProcPreviews(site) {
  const cp = procedures.find((p) => p.id === site.checkinProcedureId);
  const lp = procedures.find((p) => p.id === site.loginProcedureId);
  $('#checkinProcPreview').innerHTML = cp ? procPreviewHtml(cp) : '<span class="hint">未选择签到流程</span>';
  $('#loginProcPreview').innerHTML = lp ? procPreviewHtml(lp) : '<span class="hint">不需要登录流程可留空</span>';
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
    if (!site.checkinProcedureId) throw new Error('请选择签到流程');
    // 保存流程（可能在流程编辑器里改了但没存——这里不自动存，流程库自己有保存按钮）
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
    setFormMsg('已加入签到队列，请查看浏览器标签与日志', 'ok');
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
  const proc = createProcedure({ kind, name: kind === 'login' ? '新登录流程' : '新签到流程' });
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

// ===================== 流程库 =====================

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
    list.innerHTML = '<div class="empty-hint compact">暂无流程<br><small>点右上角「新建流程」</small></div>';
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

  const list = $('#procStepsList');
  list.innerHTML = '';
  for (const step of proc.steps?.length ? proc.steps : (proc.kind === 'login' ? [{ type: 'click', selector: '', timeoutMs: 15000 }] : [{ type: 'click', selector: '.checkin', timeoutMs: 15000 }])) {
    addStepRow(list, step);
  }

  $('#procDetailTitle').textContent = proc.name;
  $('#procDetailMeta').innerHTML = `
    <span class="kind-tag kind-${proc.kind}">${PROCEDURE_KIND_LABEL[proc.kind]}流程</span>
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
          <input name="notLoggedInKeywords" value="${escapeHtml((d.notLoggedInKeywords || []).join(','))}" placeholder="请登录,登录后操作" />
        </div>
      </div>
      <p class="hint">签到中若地址命中「登录页 URL 模式」或页面出现「未登录关键词」，扩展会自动中断签到、执行下面的登录步骤，然后重试签到一次。</p>
    `;
  } else {
    $('#procDetectTitle').textContent = '结果判定';
    $('#procDetectDesc').textContent = '根据页面文字判断签到是否成功';
    body.innerHTML = `
      <div class="grid-2">
        <div class="field">
          <label>成功关键词（逗号分隔）</label>
          <input name="successKeywords" value="${escapeHtml((d.successKeywords || []).join(','))}" placeholder="签到成功,已签到" />
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
    name: form.name.value.trim() || '未命名流程',
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
    if (!confirm(`该流程正被 ${refs.length} 个站点引用，删除后这些站点将无法签到。确定删除？`)) return;
  } else if (!confirm('确定删除该流程？')) return;
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
  $('#btnProcAddStep').addEventListener('click', () => addStepRow($('#procStepsList')));
  $('#btnProcResetScript').addEventListener('click', () => { $('#procForm [name="script"]').value = SCRIPT_TEMPLATE; });
  $('#procKind').addEventListener('change', () => {
    const proc = collectProcFromForm();
    renderProcDetectFields(proc);
  });
  $('#procForm [name="procMode"]').forEach((r) => r.addEventListener('change', syncProcModeBlocks));
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
    if (e.target.name === 'name') $('#procDetailTitle').textContent = e.target.value || '流程';
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
        ? `<button class="btn sm primary" data-install="${escapeHtml(item.marketId)}">升级到 v${escapeHtml(item.version)}</button>`
        : '<span class="mini-badge sched">已安装</span>';
    } else {
      action = `<button class="btn sm" data-install="${escapeHtml(item.marketId)}">安装</button>`;
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
    <td class="col-status"><span class="badge ${log.status}">${escapeHtml(STATUS_LABEL[log.status] || log.status)}</span></td>
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
  fillMarketUrl();
}

async function onSaveSettings(e) {
  e.preventDefault();
  const form = $('#settingsForm');
  await saveSettings({
    notifyOnComplete: form.notifyOnComplete.checked,
    notifyOnError: form.notifyOnError.checked,
    openInBackground: form.openInBackground.checked,
    siteGapMs: Number(form.siteGapMs.value) || 0,
    maxLogs: Number(form.maxLogs.value) || 200,
    defaultCfTimeoutMs: Number(form.defaultCfTimeoutMs.value) || 90000,
    cfManualGraceMs: Number(form.cfManualGraceMs.value) || 0,
  });
  const msg = $('#settingsMsg');
  msg.textContent = '设置已保存';
  msg.className = 'form-msg ok';
}

async function onExport() {
  const data = await exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `auto-checkin-export-${dateStamp()}.json`;
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
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
