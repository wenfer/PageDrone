/**
 * Browser Skills — 封装后的浏览器操作工具
 * 供 Agent 循环调用执行浏览器自动化任务
 * 基于 runner.js 的 Chrome API 模式，统一错误处理和超时
 */

import { setRuntime } from './storage.js';

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * 执行 Chrome tabs API 操作（通用封装）
 */
async function executeTabOp(tabId, op) {
  try {
    return await op();
  } catch (e) {
    console.warn(`[browser-skills] tab op failed: ${e.message}`);
    throw new Error(`标签页操作失败: ${e.message}`);
  }
}

/**
 * 打开新标签页
 * @param {string} url
 * @param {boolean} active
 * @returns {Promise<{tabId: number}>}
 */
export async function openTab(url, active = true) {
  const tab = await executeTabOp(null, () => chrome.tabs.create({ url, active }));
  await setRuntime({ message: `已打开标签: ${url}` });
  return { tabId: tab.id };
}

/**
 * 关闭标签页
 * @param {number} tabId
 */
export async function closeTab(tabId) {
  await executeTabOp(tabId, () => chrome.tabs.remove(tabId));
  await setRuntime({ message: `已关闭标签 ${tabId}` });
}

/**
 * 跳转到 URL（等效于 goto 步骤）
 * @param {number} tabId
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean}>}
 */
export async function navigateTo(tabId, url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await executeTabOp(tabId, () => chrome.tabs.update(tabId, { url }));
  await setRuntime({ message: `已跳转到: ${url}` });
  // 等待加载完成（复用 runner 模式）
  try {
    await new Promise(r => setTimeout(r, 1000));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 点击元素
 * @param {number} tabId
 * @param {string} selector
 * @param {object} options
 * @returns {Promise<{ok: boolean}>}
 */
export async function click(tabId, selector, options = {}) {
  const timeout = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  await setRuntime({ message: `点击元素: ${selector}` });
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const el = document.querySelector(sel) || document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE).singleNodeValue;
      if (!el) return false;
      el.scrollIntoView({ behavior: 'smooth' });
      el.focus();
      el.click();
      return true;
    },
    args: [selector]
  });
  return { ok: result[0]?.result || false };
}

/**
 * 输入文本到元素
 * @param {number} tabId
 * @param {string} selector
 * @param {string} text
 * @param {object} options
 * @returns {Promise<{ok: boolean}>}
 */
export async function type(tabId, selector, text, options = {}) {
  await setRuntime({ message: `输入文本到: ${selector} = ${text}` });
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, t) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.value = t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    args: [selector, text]
  });
  return { ok: result[0]?.result || false };
}

/**
 * 获取页面文本（用于检测状态）
 * @param {number} tabId
 * @param {string} selector
 * @returns {Promise<{text: string}>}
 */
export async function getText(tabId, selector = 'body') {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const el = document.querySelector(sel) || document.body;
      return el ? el.innerText || el.textContent : '';
    },
    args: [selector]
  });
  return { text: result[0]?.result || '' };
}

/**
 * 等待元素出现（带超时）
 * @param {number} tabId
 * @param {string} selector
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean}>}
 */
export async function waitFor(tabId, selector, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const has = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => !!document.querySelector(sel),
      args: [selector]
    });
    if (has[0]?.result) return { ok: true };
    await new Promise(r => setTimeout(r, 500));
  }
  return { ok: false, timeout: true };
}

/**
 * 执行自定义脚本（通用注入）
 * @param {number} tabId
 * @param {string} scriptCode
 * @returns {Promise<{result: any}>}
 */
export async function executeScript(tabId, scriptCode) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (code) => {
      try {
        const fn = new Function(code);
        return fn();
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [scriptCode]
  });
  return { result: result[0]?.result };
}

/**
 * 获取当前 URL
 * @param {number} tabId
 * @returns {Promise<{url: string}>}
 */
export async function getCurrentUrl(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return { url: tab.url || '' };
}

/**
 * 检查元素是否存在
 * @param {number} tabId
 * @param {string} selector
 * @returns {Promise<{exists: boolean}>}
 */
export async function hasElement(tabId, selector) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => !!document.querySelector(sel),
    args: [selector]
  });
  return { exists: result[0]?.result || false };
}

/**
 * 滚动到元素
 * @param {number} tabId
 * @param {string} selector
 * @returns {Promise<{ok: boolean}>}
 */
export async function scrollTo(tabId, selector) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ behavior: 'smooth' });
      return !!el;
    },
    args: [selector]
  });
  return { ok: result[0]?.result };
}

/**
 * 等待页面导航完成
 * @param {number} tabId
 * @param {string} beforeUrl
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean}>}
 */
export async function waitForNavigation(tabId, beforeUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { ok: false };
    if (tab.url && tab.url !== beforeUrl) return { ok: true };
    await new Promise(r => setTimeout(r, 200));
  }
  return { ok: false, timeout: true };
}
