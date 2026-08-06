/**
 * 步骤行编辑器：把 #stepTpl 渲染到任意容器，提供增删改查。
 * 同时供站点的登录/操作步骤（旧）和任务库使用。
 */

const STEP_UI = {
  waitFor: {
    mainLabel: '目标（CSS 或 XPath）',
    extraLabel: '附加（一般不用）',
    mainPh: 'CSS: .checkin   或 XPath: //button[contains(.,"执行")]',
    extraPh: '可留空',
    timeout: 15000,
    desc: '等到该元素出现再继续。支持 <strong>CSS</strong>（如 <code>.checkin</code>）和 <strong>XPath</strong>（如 <code>//button[contains(.,"执行")]</code>）。',
  },
  click: {
    mainLabel: '要点击的目标（CSS 或 XPath）',
    extraLabel: '回调 URL 片段（可选）',
    mainPh: 'CSS: .checkin   或 XPath: //button[contains(.,"执行")]',
    extraPh: 'OAuth 时可填回调地址关键字',
    timeout: 15000,
    desc: '点击匹配元素。默认会自动等待页面重定向/刷新完成；若弹出 OAuth 窗口请勾「监视弹窗」。',
  },
  wait: {
    mainLabel: '（本步不需要选择器）',
    extraLabel: '等待多少毫秒',
    mainPh: '留空即可',
    extraPh: '例如 2000 = 等 2 秒',
    timeout: '',
    desc: '什么也不点，只干等一段时间。1000 毫秒 = 1 秒。',
  },
  waitForText: {
    mainLabel: '在哪个区域找字',
    extraLabel: '期望出现的文字',
    mainPh: '默认 body（表示整页）',
    extraPh: '例如 执行成功',
    timeout: 10000,
    desc: '反复检查页面文字，直到出现你填的内容。主框一般填 <code>body</code>，附加框填「执行成功」等。',
  },
  type: {
    mainLabel: '输入框选择器',
    extraLabel: '要输入的内容',
    mainPh: '例如 #username',
    extraPh: '要填进去的文字',
    timeout: 10000,
    desc: '向输入框填入文字。敏感信息会保存在本机扩展配置中，请谨慎。',
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
    mainPh: '例如 /dashboard',
    extraPh: '留空',
    timeout: 60000,
    desc: '等到浏览器地址栏的网址包含你填的文字。也支持正则，如 <code>/user\\/\\d+/</code>。',
  },
  manual: {
    mainLabel: '完成后应出现的元素（可选）',
    extraLabel: '给你看的提示文案',
    mainPh: '例如 .avatar',
    extraPh: '例如：请完成 OAuth 登录',
    timeout: 180000,
    desc: '扩展会暂停并把标签页弹到前台，等你手动操作（登录、验证码、OAuth 授权）。',
  },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

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

  if (flags) flags.style.visibility = type === 'click' ? 'visible' : 'hidden';
  selectorInput.disabled = type === 'wait';
  if (type === 'wait') selectorInput.value = '';
}

function renumberSteps(listEl) {
  $$('.step-item', listEl).forEach((node, i) => {
    const idx = $('.step-index', node);
    if (idx) idx.textContent = String(i + 1);
  });
}

export function addStepRow(listEl, step = { type: 'click', selector: '', timeoutMs: 15000 }) {
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
    step.timeoutMs ?? step.ms ??
    (defaultTimeout !== '' && defaultTimeout != null ? defaultTimeout : '');
  watchPopup.checked = !!step.watchPopup;
  waitNav.checked = type === 'click' ? step.waitNavigation !== false : !!step.waitNavigation;

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
  } else if (type === 'click') {
    extraInput.value = step.returnMatch || step.match || '';
  }

  applyStepUI(type, node);

  typeSel.addEventListener('change', () => {
    const t = typeSel.value;
    applyStepUI(t, node);
    if (t === 'wait' && !extraInput.value) extraInput.value = '2000';
    if (t === 'waitForText' && !selectorInput.value) selectorInput.value = 'body';
    if (!timeoutInput.value && STEP_UI[t]?.timeout) timeoutInput.value = STEP_UI[t].timeout;
  });

  $('.step-del', node).addEventListener('click', () => {
    node.remove();
    renumberSteps(listEl);
    listEl.dispatchEvent(new CustomEvent('steps:change', { bubbles: true }));
  });
  $('.step-up', node).addEventListener('click', () => {
    listEl.insertBefore(node, node.previousElementSibling);
    renumberSteps(listEl);
  });
  $('.step-down', node).addEventListener('click', () => {
    listEl.insertBefore(node.nextElementSibling, node);
    renumberSteps(listEl);
  });

  listEl.appendChild(node);
  renumberSteps(listEl);
  listEl.dispatchEvent(new CustomEvent('steps:change', { bubbles: true }));
  return node;
}

export function collectSteps(listEl) {
  return $$('.step-item', listEl).map((node) => {
    const type = $('.step-type', node).value;
    const selector = $('.step-selector', node).value.trim();
    const extra = $('.step-extra', node).value;
    const timeoutRaw = $('.step-timeout', node).value;
    const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
    const watchPopup = $('.step-watch-popup', node)?.checked;
    const waitNavigation = $('.step-wait-nav', node)?.checked;

    if (type === 'wait') return { type, ms: Number(extra) || Number(timeoutMs) || 1000 };
    if (type === 'waitForText') {
      return { type, selector: selector || 'body', includes: extra || '', timeoutMs: timeoutMs || 10000 };
    }
    if (type === 'type') return { type, selector, text: extra ?? '', timeoutMs: timeoutMs || 10000 };
    if (type === 'goto') return { type, url: selector, timeoutMs: timeoutMs || 45000 };
    if (type === 'waitFor') return { type, selector, timeoutMs: timeoutMs || 15000 };
    if (type === 'waitForUrl') {
      return { type, match: selector || extra, timeoutMs: timeoutMs || 60000 };
    }
    if (type === 'manual') {
      const message = extra || '请完成登录或 OAuth 授权';
      const match = node.dataset.match || (extra && !selector && !/\s/.test(extra) ? extra : '') || '';
      return { type, message, match, selector: selector || '', timeoutMs: timeoutMs || 180000 };
    }
    const clickStep = { type: 'click', selector, timeoutMs: timeoutMs || 15000, waitNavigation: !!waitNavigation };
    if (watchPopup) clickStep.watchPopup = true;
    if (extra) clickStep.returnMatch = extra.trim();
    return clickStep;
  });
}

export { STEP_UI };
