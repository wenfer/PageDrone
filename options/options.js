import { MSG } from '../lib/messaging.js';
import {
  createSite,
  SCRIPT_TEMPLATE,
  STATUS_LABEL,
} from '../lib/models.js';
import {
  getSites,
  upsertSite,
  removeSite,
  getSettings,
  saveSettings,
  getLogs,
  clearLogs,
  exportAll,
  importSites,
} from '../lib/storage.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let sites = [];
let currentId = null;

init();

async function init() {
  // tabs
  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('#btnNewSite').addEventListener('click', onNewSite);
  $('#btnAddStep').addEventListener('click', () => addStepRow(undefined, '#stepsList'));
  $('#btnAddLoginStep').addEventListener('click', () => addStepRow(undefined, '#loginStepsList'));
  $('#btnResetScript').addEventListener('click', () => {
    $('#siteForm [name="script"]').value = SCRIPT_TEMPLATE;
  });
  $('#btnToggleHelp')?.addEventListener('click', () => {
    const panel = $('#stepsHelp');
    if (!panel) return;
    panel.open = !panel.open;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('#btnLoadExample')?.addEventListener('click', () => {
    if (!confirm('将用「两步签到示例」替换当前签到步骤，是否继续？')) return;
    const list = $('#stepsList');
    list.innerHTML = '';
    const example = [
      { type: 'click', selector: '.checkin', timeoutMs: 15000 },
      { type: 'waitForText', selector: 'body', includes: '签到成功', timeoutMs: 10000 },
    ];
    for (const step of example) addStepRow(step, '#stepsList');
    setFormMsg('已填入示例：请把 .checkin 改成你网站真实按钮的选择器', 'ok');
  });

  // 登录区块显隐
  const loginEnabled = $('#loginEnabled') || $('#siteForm [name="loginEnabled"]');
  const syncLoginFields = () => {
    const on = !!loginEnabled?.checked;
    $('#loginFields')?.classList.toggle('hidden', !on);
  };
  loginEnabled?.addEventListener('change', syncLoginFields);
  // 初始化时在 fillForm 后再同步
  $('#siteForm').addEventListener('submit', onSaveSite);
  $('#btnDeleteSite').addEventListener('click', onDeleteSite);
  $('#btnTestSite').addEventListener('click', onTestSite);
  $('#btnRunAll').addEventListener('click', onRunAll);
  $('#btnStop')?.addEventListener('click', onStop);
  $('#btnClearLogs').addEventListener('click', onClearLogs);
  $('#btnExport').addEventListener('click', onExport);
  $('#btnImport').addEventListener('click', onImport);
  $('#settingsForm').addEventListener('submit', onSaveSettings);

  $$('#siteForm [name="mode"]').forEach((r) => {
    r.addEventListener('change', syncModeBlocks);
  });

  await reloadSites();
  await loadSettingsForm();
  await renderLogs();
}

function switchTab(name) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  if (name === 'logs') renderLogs();
  if (name === 'settings') loadSettingsForm();
}

async function reloadSites() {
  sites = await getSites();
  renderSiteList();
  if (currentId && sites.some((s) => s.id === currentId)) {
    selectSite(currentId);
  } else if (sites[0]) {
    selectSite(sites[0].id);
  } else {
    currentId = null;
    $('#siteForm').classList.add('hidden');
    $('#editorEmpty').classList.remove('hidden');
  }
}

function renderSiteList() {
  const list = $('#siteList');
  list.innerHTML = '';
  if (!sites.length) {
    list.innerHTML = '<div class="empty-hint">暂无站点</div>';
    return;
  }
  for (const site of sites) {
    const el = document.createElement('div');
    el.className = 'site-card' + (site.id === currentId ? ' active' : '');
    const st = site.lastResult?.status;
    el.innerHTML = `
      <div class="name">${escapeHtml(site.name)}</div>
      <div class="url">${escapeHtml(site.url)}</div>
      <div class="meta">
        ${site.enabled ? '' : '<span class="badge off">禁用</span> '}
        ${st ? `<span class="badge ${st}">${escapeHtml(STATUS_LABEL[st] || st)}</span>` : '<span class="badge">未签到</span>'}
        ${site.schedule?.enabled ? ' · 定时' : ''}
      </div>
    `;
    el.addEventListener('click', () => selectSite(site.id));
    list.appendChild(el);
  }
}

function selectSite(id) {
  currentId = id;
  const site = sites.find((s) => s.id === id);
  renderSiteList();
  if (!site) return;
  fillForm(site);
  $('#editorEmpty').classList.add('hidden');
  $('#siteForm').classList.remove('hidden');
  setFormMsg('');
}

function onNewSite() {
  const site = createSite({ name: '新站点' });
  currentId = site.id;
  // 暂不写入 storage，保存时再 upsert；为列表可见先插入内存
  sites = [site, ...sites.filter((s) => s.id !== site.id)];
  fillForm(site);
  renderSiteList();
  $('#editorEmpty').classList.add('hidden');
  $('#siteForm').classList.remove('hidden');
  setFormMsg('请填写后点击保存', '');
}

function fillForm(site) {
  const form = $('#siteForm');
  form.name.value = site.name || '';
  form.url.value = site.url || '';
  form.enabled.checked = site.enabled !== false;
  form.openInBackground.checked = site.openInBackground !== false;
  form.keepTabOnError.checked = site.keepTabOnError !== false;
  form.querySelectorAll('[name="mode"]').forEach((r) => {
    r.checked = r.value === (site.mode || 'steps');
  });
  form.script.value = site.script || SCRIPT_TEMPLATE;
  form.successKeywords.value = (site.successKeywords || []).join(',');
  form.failKeywords.value = (site.failKeywords || []).join(',');
  form.cfTimeoutMs.value = site.cfTimeoutMs ?? 90000;
  form.pageLoadTimeoutMs.value = site.pageLoadTimeoutMs ?? 45000;
  form.scheduleEnabled.checked = !!site.schedule?.enabled;
  form.scheduleHour.value = site.schedule?.hour ?? 8;
  form.scheduleMinute.value = site.schedule?.minute ?? 5;

  const login = site.login || {};
  form.loginEnabled.checked = !!login.enabled;
  form.loggedInSelector.value = login.loggedInSelector || '';
  form.loggedInUrlIncludes.value = login.loggedInUrlIncludes || '';
  form.loginTimeoutMs.value = login.timeoutMs ?? 180000;

  const stepsList = $('#stepsList');
  stepsList.innerHTML = '';
  const steps = site.steps?.length
    ? site.steps
    : [
        { type: 'click', selector: '.checkin', timeoutMs: 15000 },
        { type: 'waitForText', selector: 'body', includes: '签到成功', timeoutMs: 10000 },
      ];
  for (const step of steps) addStepRow(step, '#stepsList');

  const loginStepsList = $('#loginStepsList');
  loginStepsList.innerHTML = '';
  const loginSteps = login.steps?.length
    ? login.steps
    : [
        {
          type: 'click',
          selector: 'a[href*="oauth"], button.oauth',
          timeoutMs: 15000,
          watchPopup: true,
        },
        {
          type: 'manual',
          message: '请完成 OAuth 授权',
          match: '',
          timeoutMs: 180000,
        },
      ];
  for (const step of loginSteps) addStepRow(step, '#loginStepsList');
  syncModeBlocks();
  const loginOn = !!form.loginEnabled?.checked;
  $('#loginFields')?.classList.toggle('hidden', !loginOn);
  renumberSteps('#stepsList');
  renumberSteps('#loginStepsList');
}

function syncModeBlocks() {
  const mode = $('#siteForm [name="mode"]:checked')?.value || 'steps';
  $('#stepsBlock').classList.toggle('hidden', mode !== 'steps');
  $('#scriptBlock').classList.toggle('hidden', mode !== 'script');
}

/** 各步骤类型的界面文案 */
const STEP_UI = {
  waitFor: {
    mainLabel: '目标（CSS 或 XPath）',
    extraLabel: '附加（一般不用）',
    mainPh: 'CSS: .checkin   或 XPath: //button[contains(.,"签到")]',
    extraPh: '可留空',
    timeout: 15000,
    desc: '等到该元素出现再继续。支持 <strong>CSS</strong>（如 <code>.checkin</code>）和 <strong>XPath</strong>（如 <code>//button[contains(.,"签到")]</code>）。Chrome 里可对元素右键 → Copy → Copy selector / Copy XPath。',
  },
  click: {
    mainLabel: '要点击的目标（CSS 或 XPath）',
    extraLabel: '回调 URL 片段（可选）',
    mainPh: 'CSS: .checkin   或 XPath: //button[contains(.,"签到")]',
    extraPh: 'OAuth 时可填回调地址关键字',
    timeout: 15000,
    desc: '点击匹配元素。默认会自动等待页面重定向/刷新完成；若弹出 OAuth 窗口请勾「监视弹窗」。仅当确定不会跳转且想跳过等待时，才取消「等页面跳转」。',
  },
  wait: {
    mainLabel: '（本步不需要选择器）',
    extraLabel: '等待多少毫秒',
    mainPh: '留空即可',
    extraPh: '例如 2000 = 等 2 秒',
    timeout: '',
    desc: '什么也不点，只干等一段时间。适合等动画结束或接口返回。1000 毫秒 = 1 秒。',
  },
  waitForText: {
    mainLabel: '在哪个区域找字',
    extraLabel: '期望出现的文字',
    mainPh: '默认 body（表示整页）',
    extraPh: '例如 签到成功',
    timeout: 10000,
    desc: '反复检查页面文字，直到出现你填的内容。主框一般填 <code>body</code>，附加框填「签到成功」「已签到」等。',
  },
  type: {
    mainLabel: '输入框选择器',
    extraLabel: '要输入的内容',
    mainPh: '例如 #username  或  input[name=pwd]',
    extraPh: '要填进去的文字',
    timeout: 10000,
    desc: '向输入框填入文字（用于需要账号的场景）。密码等敏感信息会保存在本机扩展配置中，请谨慎。',
  },
  goto: {
    mainLabel: '要打开的网址',
    extraLabel: '附加（不用填）',
    mainPh: 'https://example.com/checkin',
    extraPh: '留空',
    timeout: 45000,
    desc: '让当前标签跳转到另一个完整网址（必须以 http:// 或 https:// 开头）。',
  },
  waitForUrl: {
    mainLabel: '地址栏应包含的内容',
    extraLabel: '附加（不用填）',
    mainPh: '例如 /dashboard  或  checkin',
    extraPh: '留空',
    timeout: 60000,
    desc: '等到浏览器地址栏的网址包含你填的文字。也支持正则，如 <code>/user\\/\\d+/</code>。适合 OAuth 跳转回来后确认。',
  },
  manual: {
    mainLabel: '完成后应出现的元素（可选）',
    extraLabel: '给你看的提示文案',
    mainPh: '例如 .avatar（登录成功标志）',
    extraPh: '例如：请完成 OAuth 登录',
    timeout: 180000,
    desc: '扩展会暂停并把标签页弹到前台，等你手动操作（登录、点验证码、OAuth 授权）。完成后根据「出现的元素」或离开授权页自动继续。',
  },
};

function applyStepUI(type, node) {
  const meta = STEP_UI[type] || STEP_UI.waitFor;
  const selectorInput = $('.step-selector', node);
  const extraInput = $('.step-extra', node);
  const mainLabel = $('.step-label-main', node);
  const extraLabel = $('.step-label-extra', node);
  const desc = $('.step-desc', node);
  const flags = $('.step-flags', node);

  if (mainLabel) mainLabel.textContent = meta.mainLabel;
  if (extraLabel) extraLabel.textContent = meta.extraLabel;
  selectorInput.placeholder = meta.mainPh;
  extraInput.placeholder = meta.extraPh;
  if (desc) desc.innerHTML = meta.desc;

  // 只有点击类步骤显示弹窗/导航选项
  if (flags) {
    flags.style.visibility = type === 'click' ? 'visible' : 'hidden';
  }
  // 点击默认勾选「等页面跳转」（与 runner 默认 autoNav 一致）
  const waitNavBox = $('.step-wait-nav', node);
  if (type === 'click' && waitNavBox && !waitNavBox.dataset.userTouched) {
    // 仅在新建步骤且未设置时默认勾选；已有数据由 fill 控制
  }

  // 固定等待时禁用主输入
  selectorInput.disabled = type === 'wait';
  if (type === 'wait') selectorInput.value = '';
}

function renumberSteps(listSel) {
  $$(`${listSel} .step-item`).forEach((node, i) => {
    const idx = $('.step-index', node);
    if (idx) idx.textContent = String(i + 1);
  });
}

function addStepRow(step = { type: 'click', selector: '', timeoutMs: 15000 }, listSel = '#stepsList') {
  const tpl = $('#stepTpl');
  const node = tpl.content.firstElementChild.cloneNode(true);
  const typeSel = $('.step-type', node);
  const selectorInput = $('.step-selector', node);
  const extraInput = $('.step-extra', node);
  const timeoutInput = $('.step-timeout', node);
  const watchPopup = $('.step-watch-popup', node);
  const waitNav = $('.step-wait-nav', node);

  const type = step.type || 'click';
  typeSel.value = type;
  selectorInput.value = step.selector || step.url || step.match || '';
  const defaultTimeout = STEP_UI[type]?.timeout;
  timeoutInput.value =
    step.timeoutMs ??
    step.ms ??
    (defaultTimeout !== '' && defaultTimeout != null ? defaultTimeout : '');
  watchPopup.checked = !!step.watchPopup;
  // 点击步骤：未显式写 false 时默认勾选「等页面跳转」
  if (type === 'click') {
    waitNav.checked = step.waitNavigation !== false;
  } else {
    waitNav.checked = !!step.waitNavigation;
  }

  if (type === 'wait') {
    extraInput.value = step.ms ?? 1000;
  } else if (type === 'waitForText') {
    extraInput.value = step.includes || '';
    if (!selectorInput.value) selectorInput.value = 'body';
  } else if (type === 'type') {
    extraInput.value = step.text || '';
  } else if (type === 'goto') {
    selectorInput.value = step.url || '';
  } else if (type === 'waitForUrl') {
    selectorInput.value = step.match || step.includes || step.url || step.selector || '';
  } else if (type === 'manual') {
    selectorInput.value = step.selector || '';
    extraInput.value = step.message || step.match || '';
    if (step.match && step.message) {
      extraInput.value = step.message;
      node.dataset.match = step.match;
    } else if (step.match && !step.message) {
      extraInput.value = step.match;
    }
  } else if (type === 'click') {
    extraInput.value = step.returnMatch || step.match || '';
  }

  applyStepUI(type, node);

  typeSel.addEventListener('change', () => {
    const t = typeSel.value;
    applyStepUI(t, node);
    if (t === 'wait' && !extraInput.value) extraInput.value = '2000';
    if (t === 'waitForText' && !selectorInput.value) selectorInput.value = 'body';
    if (!timeoutInput.value && STEP_UI[t]?.timeout) {
      timeoutInput.value = STEP_UI[t].timeout;
    }
  });

  $('.step-del', node).addEventListener('click', () => {
    node.remove();
    renumberSteps(listSel);
  });
  $('.step-up', node).addEventListener('click', () => {
    node.parentElement?.insertBefore(node, node.previousElementSibling);
    renumberSteps(listSel);
  });
  $('.step-down', node).addEventListener('click', () => {
    node.parentElement?.insertBefore(node.nextElementSibling, node);
    renumberSteps(listSel);
  });

  $(listSel).appendChild(node);
  renumberSteps(listSel);
}

function collectSteps(listSel = '#stepsList') {
  return $$(`${listSel} .step-item`).map((node) => {
    const type = $('.step-type', node).value;
    const selector = $('.step-selector', node).value.trim();
    const extra = $('.step-extra', node).value;
    const timeoutRaw = $('.step-timeout', node).value;
    const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
    const watchPopup = $('.step-watch-popup', node)?.checked;
    const waitNavigation = $('.step-wait-nav', node)?.checked;

    if (type === 'wait') {
      return { type, ms: Number(extra) || Number(timeoutMs) || 1000 };
    }
    if (type === 'waitForText') {
      return {
        type,
        selector: selector || 'body',
        includes: extra || '',
        timeoutMs: timeoutMs || 10000,
      };
    }
    if (type === 'type') {
      return { type, selector, text: extra ?? '', timeoutMs: timeoutMs || 10000 };
    }
    if (type === 'goto') {
      return { type, url: selector, timeoutMs: timeoutMs || 45000 };
    }
    if (type === 'waitFor') {
      return { type, selector, timeoutMs: timeoutMs || 15000 };
    }
    if (type === 'waitForUrl') {
      return {
        type,
        match: selector || extra,
        timeoutMs: timeoutMs || 60000,
      };
    }
    if (type === 'manual') {
      // extra 优先当提示文案；若像 URL 片段则同时作 match
      const message = extra || '请完成登录或 OAuth 授权';
      const match = node.dataset.match || (extra && !selector && !/\s/.test(extra) ? extra : '') || '';
      return {
        type,
        message,
        match,
        selector: selector || '',
        timeoutMs: timeoutMs || 180000,
      };
    }
    // click：以勾选框为准；默认新建步骤会勾选「等页面跳转」
    const clickStep = {
      type: 'click',
      selector,
      timeoutMs: timeoutMs || 15000,
      waitNavigation: !!waitNavigation,
    };
    if (watchPopup) clickStep.watchPopup = true;
    if (extra) clickStep.returnMatch = extra.trim();
    return clickStep;
  });
}

function collectSiteFromForm() {
  const form = $('#siteForm');
  const mode = form.querySelector('[name="mode"]:checked')?.value || 'steps';
  const split = (s) =>
    String(s || '')
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean);

  const existing = sites.find((s) => s.id === currentId) || createSite({ id: currentId });
  return {
    ...existing,
    id: currentId || existing.id,
    name: form.name.value.trim(),
    url: form.url.value.trim(),
    enabled: form.enabled.checked,
    openInBackground: form.openInBackground.checked,
    keepTabOnError: form.keepTabOnError.checked,
    mode,
    steps: collectSteps('#stepsList'),
    script: form.script.value,
    login: {
      enabled: form.loginEnabled.checked,
      loggedInSelector: form.loggedInSelector.value.trim(),
      loggedInUrlIncludes: form.loggedInUrlIncludes.value.trim(),
      steps: collectSteps('#loginStepsList'),
      timeoutMs: Number(form.loginTimeoutMs.value) || 180000,
    },
    successKeywords: split(form.successKeywords.value),
    failKeywords: split(form.failKeywords.value),
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

function clamp(n, min, max, fallback) {
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function onSaveSite(e) {
  e.preventDefault();
  try {
    const site = collectSiteFromForm();
    if (!site.name) throw new Error('请填写名称');
    if (!site.url || !/^https?:\/\//i.test(site.url)) {
      throw new Error('请填写有效的 http(s) URL');
    }
    if (site.mode === 'steps' && !site.steps.length) {
      throw new Error('请至少添加一个步骤');
    }
    await upsertSite(site);
    // 通知 background 重排定时
    try {
      await chrome.runtime.sendMessage({ type: MSG.RESCHEDULE });
    } catch {
      /* ignore */
    }
    setFormMsg('已保存', 'ok');
    await reloadSites();
    selectSite(site.id);
  } catch (err) {
    setFormMsg(err.message || String(err), 'err');
  }
}

async function onDeleteSite() {
  if (!currentId) return;
  if (!confirm('确定删除该站点？')) return;
  await removeSite(currentId);
  currentId = null;
  try {
    await chrome.runtime.sendMessage({ type: MSG.RESCHEDULE });
  } catch {
    /* ignore */
  }
  await reloadSites();
  setFormMsg('已删除', 'ok');
}

async function onTestSite() {
  try {
    // 先保存再测
    const site = collectSiteFromForm();
    await upsertSite(site);
    currentId = site.id;
    const res = await chrome.runtime.sendMessage({
      type: MSG.RUN_SITE,
      siteId: site.id,
      force: true,
    });
    if (!res?.ok) throw new Error(res?.error || '启动失败');
    setFormMsg('已加入签到队列，请查看浏览器标签与日志', 'ok');
  } catch (err) {
    setFormMsg(err.message || String(err), 'err');
  }
}

async function onRunAll() {
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.RUN_ALL });
    if (!res?.ok) throw new Error(res?.error || '启动失败');
    alert(`已排队 ${res.queued} 个站点`);
  } catch (e) {
    alert(e.message || String(e));
  }
}

async function onStop() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'STOP',
      reason: '用户强制停止',
    });
    if (!res?.ok) throw new Error(res?.error || '停止失败');
    alert('已强制停止队列。现在可以重新点「立即测试签到」。');
  } catch (e) {
    const msg = e.message || String(e);
    if (/未知消息类型|Receiving end does not exist/i.test(msg)) {
      alert(
        '强制停止失败：请到 chrome://extensions 对本扩展点「重新加载」，然后再点强制停止。\n\n' +
          msg
      );
    } else {
      alert(msg);
    }
  }
}

function setFormMsg(text, cls = '') {
  const el = $('#formMsg');
  el.textContent = text || '';
  el.className = 'form-msg' + (cls ? ' ' + cls : '');
}

async function loadSettingsForm() {
  const s = await getSettings();
  const form = $('#settingsForm');
  form.notifyOnComplete.checked = s.notifyOnComplete !== false;
  form.notifyOnError.checked = s.notifyOnError !== false;
  form.openInBackground.checked = s.openInBackground !== false;
  form.siteGapMs.value = s.siteGapMs ?? 2000;
  form.maxLogs.value = s.maxLogs ?? 200;
  form.defaultCfTimeoutMs.value = s.defaultCfTimeoutMs ?? 90000;
  form.cfManualGraceMs.value = s.cfManualGraceMs ?? 120000;
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

async function renderLogs() {
  const logs = await getLogs();
  const root = $('#logTable');
  if (!logs.length) {
    root.innerHTML = '<div class="empty-hint">暂无日志</div>';
    return;
  }
  const rows = logs
    .map((log) => {
      return `<tr>
        <td>${escapeHtml(formatTime(log.finishedAt || log.startedAt))}</td>
        <td>${escapeHtml(log.siteName || log.siteId)}</td>
        <td><span class="badge ${log.status}">${escapeHtml(STATUS_LABEL[log.status] || log.status)}</span></td>
        <td>${escapeHtml(log.message || '')}</td>
        <td>${log.cfWaitedMs ? log.cfWaitedMs + 'ms' : '-'}</td>
      </tr>`;
    })
    .join('');
  root.innerHTML = `<table>
    <thead><tr>
      <th>时间</th><th>站点</th><th>状态</th><th>消息</th><th>CF等待</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function onClearLogs() {
  if (!confirm('确定清空全部日志？')) return;
  await clearLogs();
  await renderLogs();
}

async function onExport() {
  const data = await exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
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
  if (!file) {
    $('#ioMsg').textContent = '请先选择文件';
    $('#ioMsg').className = 'form-msg err';
    return;
  }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const replace = $('#importReplace').checked;
    await importSites(data, { merge: !replace });
    try {
      await chrome.runtime.sendMessage({ type: MSG.RESCHEDULE });
    } catch {
      /* ignore */
    }
    await reloadSites();
    $('#ioMsg').textContent = '导入成功';
    $('#ioMsg').className = 'form-msg ok';
  } catch (e) {
    $('#ioMsg').textContent = e.message || String(e);
    $('#ioMsg').className = 'form-msg err';
  }
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function dateStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
