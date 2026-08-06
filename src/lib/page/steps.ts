/**
 * 注入页面执行的单步执行器（CSS + XPath）。
 * 自包含：findElement / waitForSelector / waitForText 全部定义在函数体内，
 * 因为 chrome.scripting 只序列化传入的这一个函数。
 */

export interface PageStepResult {
  ok: boolean;
  message: string;
}

interface RawStep {
  type?: string;
  selector?: string;
  includes?: string;
  text?: string;
  ms?: number;
  timeoutMs?: number;
}

export function pageRunOneStep(step: RawStep): Promise<PageStepResult> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function findElement(selector: string | null | undefined): Element | null {
    if (selector == null || selector === '') return null;
    const raw = String(selector).trim();
    if (!raw) return null;
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
      try {
        const result = document.evaluate(
          expr,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        return (result.singleNodeValue as Element) || null;
      } catch (e) {
        throw new Error(`XPath 无效: ${expr}（${(e as Error).message || e}）`);
      }
    }
    try {
      return document.querySelector(expr);
    } catch (e) {
      throw new Error(`CSS 选择器无效: ${expr}（${(e as Error).message || e}）`);
    }
  }

  async function waitForSelector(selector: string, timeoutMs: number): Promise<Element> {
    const start = Date.now();
    let lastErr: unknown = null;
    while (Date.now() - start < timeoutMs) {
      try {
        const el = findElement(selector);
        if (el) return el;
      } catch (e) {
        lastErr = e;
      }
      await sleep(200);
    }
    if (lastErr) throw lastErr;
    throw new Error(`等待元素超时: ${selector}`);
  }

  async function waitForText(selector: string, includes: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let el: Element | null = document.body;
      if (selector && selector !== 'body') {
        try {
          el = findElement(selector) || document.body;
        } catch {
          el = document.body;
        }
      }
      const text = (el as HTMLElement | null)?.innerText || el?.textContent || '';
      if (text.includes(includes)) return;
      await sleep(200);
    }
    throw new Error(`等待文本超时: "${includes}"`);
  }

  return (async () => {
    try {
      const type = step?.type;
      if (type === 'wait') {
        await sleep(Number(step?.ms) || 1000);
      } else if (type === 'waitFor') {
        await waitForSelector(step?.selector || '', Number(step?.timeoutMs) || 15000);
      } else if (type === 'click') {
        const el = (await waitForSelector(
          step?.selector || '',
          Number(step?.timeoutMs) || 10000
        )) as HTMLElement;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus?.();
        el.click();
      } else if (type === 'waitForText') {
        await waitForText(
          step?.selector || 'body',
          step?.includes || '',
          Number(step?.timeoutMs) || 10000
        );
      } else if (type === 'type') {
        const el = (await waitForSelector(
          step?.selector || '',
          Number(step?.timeoutMs) || 10000
        )) as HTMLElement;
        el.focus?.();
        if ('value' in el) {
          (el as HTMLInputElement).value = step?.text ?? '';
        } else {
          el.textContent = step?.text ?? '';
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (type === 'goto' || type === 'waitForUrl' || type === 'manual') {
        return { ok: true, message: 'skip-in-page' };
      } else {
        throw new Error(`未知步骤类型: ${type}`);
      }
      return { ok: true, message: 'ok' };
    } catch (e) {
      return { ok: false, message: (e as Error)?.message || String(e) };
    }
  })();
}
