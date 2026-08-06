/**
 * 注入页面执行的选择器探测函数。
 * 经 chrome.scripting.executeScript({func}) 序列化到目标页 world，
 * 因此必须自包含：不得引用模块 import，辅助逻辑内联在函数体内。
 */

/** 判断选择器/XPath 是否存在（函数体自包含） */
export function pageQueryExists(selector: string): boolean {
  try {
    if (selector == null || selector === '') return false;
    const raw = String(selector).trim();
    if (!raw) return false;
    let mode: 'auto' | 'xpath' | 'css' = 'auto';
    let expr = raw;
    if (/^xpath\s*:/i.test(raw)) {
      mode = 'xpath';
      expr = raw.replace(/^xpath\s*:/i, '').trim();
    } else if (/^css\s*:/i.test(raw)) {
      mode = 'css';
      expr = raw.replace(/^css\s*:/i, '').trim();
    }
    const looksLikeXPath =
      mode === 'xpath' ||
      (mode === 'auto' &&
        (/^\s*(\/\/|\.\/\/|\(\/\/|\(\.\/\/)/.test(expr) ||
          /^\s*\/html\b/i.test(expr) ||
          /^\s*\/body\b/i.test(expr) ||
          /^\s*id\s*\(/i.test(expr)));
    if (looksLikeXPath) {
      const result = document.evaluate(
        expr,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      return !!result.singleNodeValue;
    }
    return !!document.querySelector(expr);
  } catch {
    return false;
  }
}
