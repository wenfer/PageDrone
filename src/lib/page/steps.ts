/**
 * 注入页面执行的单步执行器（CSS + XPath）。
 * 自包含：findElement / waitForSelector / waitForText 全部定义在函数体内，
 * 因为 chrome.scripting 只序列化传入的这一个函数。
 */

export interface PageStepResult {
  ok: boolean;
  message: string;
}

export interface AutofilledLoginResult {
  hasPasswordField: boolean;
  credentialsReady: boolean;
  submitted: boolean;
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
        if (el instanceof HTMLInputElement && el.type.toLowerCase() === 'password') {
          throw new Error('禁止在技能中填写密码，请使用 Chrome 自动填充后提交登录表单');
        }
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

/**
 * 提交 Chrome 已自动填充的普通登录表单。
 *
 * 该函数会被 chrome.scripting.executeScript 序列化注入页面，必须自包含。
 * 只在页面内判断字段是否非空，不读取、不返回账号或密码内容。
 */
export async function pageSubmitAutofilledLogin(): Promise<AutofilledLoginResult> {
  function isVisible(element: Element): boolean {
    const html = element as HTMLElement;
    const rect = html.getBoundingClientRect();
    const style = window.getComputedStyle(html);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.pointerEvents !== 'none' &&
      !html.matches(':disabled') &&
      html.getAttribute('aria-disabled') !== 'true'
    );
  }

  const password = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    .find((input) => isVisible(input));
  if (!password) {
    return {
      hasPasswordField: false,
      credentialsReady: false,
      submitted: false,
      message: '当前页面没有可见密码字段',
    };
  }

  const form = password.form || password.closest('form');
  const identity = form
    ? Array.from(form.querySelectorAll<HTMLInputElement>(
        'input[type="email"], input[type="text"], input[name*="user" i], input[name*="account" i], input[autocomplete="username"]'
      )).find((input) => isVisible(input))
    : null;
  // 只读取“是否非空”的布尔结果，字段内容不会离开目标页面。
  const passwordReady = password.value.length > 0;
  const identityReady = !identity || identity.value.length > 0;
  if (!passwordReady || !identityReady) {
    return {
      hasPasswordField: true,
      credentialsReady: false,
      submitted: false,
      message: '等待 Chrome 自动填充登录信息',
    };
  }

  // Chrome 自动填充不一定触发站点框架监听的 input 事件；只派发事件让
  // 页面同步自身校验状态，不改写字段值，也不读取字段内容。
  password.dispatchEvent(new Event('input', { bubbles: true }));
  password.dispatchEvent(new Event('change', { bubbles: true }));
  identity?.dispatchEvent(new Event('input', { bubbles: true }));
  identity?.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  const scope: ParentNode = form || document;
  const submit = Array.from(scope.querySelectorAll<HTMLElement>(
    'button[type="submit"], input[type="submit"], button:not([type])'
  )).find((element) => {
    if (!isVisible(element)) return false;
    if (form) return true;
    const label = `${element.innerText || ''} ${(element as HTMLInputElement).value || ''} ${element.getAttribute('aria-label') || ''}`;
    return /登录|登錄|sign\s*in|log\s*in/i.test(label);
  });
  if (!submit) {
    if (form && typeof form.requestSubmit === 'function') {
      if (form.getAttribute('data-pagedrone-login-submitted') === 'true') {
        return {
          hasPasswordField: true,
          credentialsReady: true,
          submitted: false,
          message: '登录表单已提交，等待页面响应',
        };
      }
      form.setAttribute('data-pagedrone-login-submitted', 'true');
      form.requestSubmit();
      return {
        hasPasswordField: true,
        credentialsReady: true,
        submitted: true,
        message: '已提交 Chrome 自动填充的登录表单',
      };
    }
    return {
      hasPasswordField: true,
      credentialsReady: true,
      submitted: false,
      message: '登录信息已填充，但没有找到可见的提交按钮',
    };
  }

  if (submit.getAttribute('data-pagedrone-login-submitted') === 'true') {
    return {
      hasPasswordField: true,
      credentialsReady: true,
      submitted: false,
      message: '登录表单已提交，等待页面响应',
    };
  }

  submit.scrollIntoView({ block: 'center', inline: 'center' });
  submit.focus?.();
  submit.setAttribute('data-pagedrone-login-submitted', 'true');
  submit.click();
  return {
    hasPasswordField: true,
    credentialsReady: true,
    submitted: true,
    message: '已提交 Chrome 自动填充的登录表单',
  };
}
