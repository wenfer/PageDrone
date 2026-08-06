/**
 * Cloudflare / 防护挑战检测与 Cookie 检查
 * 检测函数会通过 chrome.scripting.executeScript 注入到页面，
 * 因此不能依赖模块 import，逻辑需自包含。
 */

export interface ChallengeSignals {
  titleHit: boolean;
  domHit: boolean;
  pathHit: boolean;
  bodyHit: boolean;
  globalHit: boolean;
}

export interface ChallengeDetectResult {
  isChallenge: boolean;
  signals?: ChallengeSignals;
  title?: string;
  url?: string;
  readyState?: string;
  error?: string;
}

/** 在页面上下文中执行的挑战检测（纯函数，可序列化注入） */
export function detectChallengeInPage(): ChallengeDetectResult {
  try {
    const title = (document.title || '').toLowerCase();
    const href = location.href || '';
    const bodyText = (document.body?.innerText || '').slice(0, 3000);

    const titleHit =
      /just a moment|请稍候|checking your browser|attention required|security check|人机验证|验证您的浏览器/i.test(
        title
      );

    const selectors = [
      '#challenge-platform',
      '#challenge-form',
      '#cf-challenge-running',
      '.cf-turnstile',
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="challenges.cloudflare.com/"]',
      '[data-sitekey]',
      '#cf-wrapper',
      '.cf-browser-verification',
      // 常见国内/通用防护
      '.geetest_panel',
      '.geetest_holder',
      '#captcha',
      '.yidun_popup',
      '.yidun_control',
    ];
    const domHit = selectors.some((sel) => {
      try {
        return !!document.querySelector(sel);
      } catch {
        return false;
      }
    });

    const pathHit = /cdn-cgi\/challenge-platform/i.test(href);
    const bodyHit =
      /checking your browser before accessing|enable javascript and cookies|请完成以下操作|进行人机身份验证|verify you are human/i.test(
        bodyText
      );

    let globalHit = false;
    try {
      globalHit =
        typeof (window as unknown as Record<string, unknown>).__cf_chl_opt !== 'undefined' ||
        typeof (window as unknown as Record<string, unknown>)._cf_chl_opt !== 'undefined';
    } catch {
      /* ignore */
    }

    const isChallenge = titleHit || domHit || pathHit || bodyHit || globalHit;
    return {
      isChallenge,
      signals: { titleHit, domHit, pathHit, bodyHit, globalHit },
      title: document.title,
      url: href,
      readyState: document.readyState,
    };
  } catch (e) {
    return {
      isChallenge: false,
      error: String(e),
      title: '',
      url: location.href,
    };
  }
}

/** 读取页面可见文本摘要（判定成功/失败关键词） */
export function getPageTextSample(maxLen = 8000): string {
  try {
    const text = document.body?.innerText || document.documentElement?.innerText || '';
    return text.replace(/\s+/g, ' ').trim().slice(0, maxLen);
  } catch {
    return '';
  }
}

/**
 * 在 SW 中检查 cf_clearance cookie
 */
export async function hasCfClearance(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const names = ['cf_clearance'];
    const domains = [host];
    const parts = host.split('.');
    if (parts.length >= 2) {
      domains.push(parts.slice(-2).join('.'));
      domains.push('.' + parts.slice(-2).join('.'));
    }
    if (parts.length >= 3) {
      domains.push(parts.slice(-3).join('.'));
      domains.push('.' + parts.slice(-3).join('.'));
    }

    for (const domain of [...new Set(domains)]) {
      for (const name of names) {
        const list = await chrome.cookies.getAll({ domain, name });
        if (list.some((c) => c.value && c.value.length > 0)) return true;
      }
    }
    // 也按 url 精确查
    for (const name of names) {
      const c = await chrome.cookies.get({ url: u.origin + '/', name });
      if (c?.value) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 判断是否仍处于挑战中
 * - 有挑战 DOM → 未通过
 * - 无挑战 DOM → 视为通过（即使没有 cf_clearance，也可能是非 CF 站或已过）
 */
export function isChallengeCleared(
  detectResult: ChallengeDetectResult | null | undefined,
  hasClearance: boolean
): boolean {
  if (!detectResult) return false;
  if (detectResult.isChallenge) return false;
  // 若曾出现 CF 信号但 cookie 已有，更稳妥
  if (detectResult.signals?.pathHit || detectResult.signals?.globalHit) {
    return !!hasClearance || !detectResult.isChallenge;
  }
  return true;
}
