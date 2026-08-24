/**
 * MCP browser 组原语：受管标签页（managed tab）上的原子操作。
 * 复用 src/lib/page/* 自包含注入函数；操作全局串行（浏览器锁）。
 * 安全：硬拒绝非 http(s) 目标（覆盖 chrome:// 等内部页面）；禁止向密码字段写入。
 */

import { CancellationToken } from '../cancellation.js';
import { buildMatcher, TabSession } from '../tab-session.js';
import { McpToolError } from './errors.js';

const BROWSER_KEY = 'mcpBrowser';

// —— 全局串行锁：同一时刻只执行一个 browser 原语，防止交错操作同一标签页 ——

let browserChain: Promise<unknown> = Promise.resolve();
export function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = browserChain.then(fn, fn);
  browserChain = run.catch(() => undefined);
  return run;
}

/** 校验目标 URL：必须是 http(s)，从协议层硬拒绝 chrome:// 等浏览器内部页面 */
export function assertSafeHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(raw || '').trim());
  } catch {
    throw new McpToolError('VALIDATION_FAILED', `网址无效：${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new McpToolError(
      'VALIDATION_FAILED',
      `仅允许 http(s) 目标，已拒绝 "${parsed.protocol}"（浏览器内部页面一律禁止操作）`,
    );
  }
  return parsed;
}

async function readBrowserStore(): Promise<{ tabId: number | null }> {
  const data = await chrome.storage.local.get(BROWSER_KEY);
  const stored = (data[BROWSER_KEY] as { tabId?: number | null }) || {};
  return { tabId: typeof stored.tabId === 'number' ? stored.tabId : null };
}

export async function getManagedTabId(): Promise<number | null> {
  const { tabId } = await readBrowserStore();
  if (tabId == null) return null;
  try {
    await chrome.tabs.get(tabId);
    return tabId;
  } catch {
    await chrome.storage.local.set({ [BROWSER_KEY]: { tabId: null } });
    return null;
  }
}

async function setManagedTabId(id: number | null): Promise<void> {
  await chrome.storage.local.set({ [BROWSER_KEY]: { tabId: id } });
}

async function requireManagedTab(): Promise<{ tabId: number; session: TabSession; token: CancellationToken }> {
  const tabId = await getManagedTabId();
  if (tabId == null) {
    throw new McpToolError('TAB_GONE', '当前没有受管标签页，请先调用 navigate 打开目标页面');
  }
  const token = new CancellationToken();
  return { tabId, session: TabSession.attach(tabId, token), token };
}

async function inject<TArgs extends unknown[], R>(func: (...args: TArgs) => R, args?: TArgs): Promise<R> {
  const { session } = await requireManagedTab();
  try {
    return await session.inject(func, args);
  } catch (e) {
    if (e instanceof Error && e.name === 'TabGoneError') throw e;
    throw new McpToolError(
      'VALIDATION_FAILED',
      `注入页面失败（页面可能拒绝扩展脚本）：${(e as Error)?.message || String(e)}`,
    );
  }
}

/** 密码字段红线：选择器命中密码输入框时拒绝写入（自包含注入函数） */
async function assertNotPasswordField(selector: string): Promise<void> {
  const isPassword = await inject((sel: string) => {
    const raw = String(sel || '').trim();
    let el: Element | null = null;
    if (/^xpath\s*:/i.test(raw)) {
      try {
        el = document.evaluate(raw.replace(/^xpath\s*:/i, ''), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
          .singleNodeValue as Element | null;
      } catch {
        el = null;
      }
    } else {
      try {
        el = document.querySelector(raw);
      } catch {
        el = null;
      }
    }
    const input = el as HTMLInputElement | null;
    return !!input && String(input.getAttribute('type') || '').toLowerCase() === 'password';
  }, [selector]);
  if (isPassword) {
    throw new McpToolError(
      'VALIDATION_FAILED',
      '安全限制：不允许通过 MCP 向密码字段写入内容。普通登录应依赖 Chrome 已保存凭据自动填充',
    );
  }
}

interface PageFingerprint {
  url: string;
  title: string;
  text: string;
  elements: string;
}

async function fingerprint(): Promise<PageFingerprint> {
  const state = await inject(await importSamplePageState(), []);
  if (!state) return { url: '', title: '', text: '', elements: '' };
  return {
    url: state.url,
    title: state.title,
    text: String(state.text || '').slice(0, 300),
    elements: (state.elements || []).map((e) => `${e.tag}:${e.selector}`).join('|'),
  };
}

function changedFingerprint(before: PageFingerprint, after: PageFingerprint): boolean {
  return (
    before.url !== after.url ||
    before.title !== after.title ||
    before.text !== after.text ||
    before.elements !== after.elements
  );
}

// 动态 import 保持与 agent-skills 相同的懒加载策略
async function importSamplePageState() {
  const mod = await import('../page/explorer-sample.js');
  return mod.samplePageState;
}

// —— 原语实现 ——

export interface NavigateOptions {
  url: string;
  tabMode?: 'managed-new' | 'managed-reuse';
}

export async function mcpNavigate(options: NavigateOptions): Promise<{ tabId: number; finalUrl: string }> {
  const parsed = assertSafeHttpUrl(options.url);
  const url = parsed.toString();
  const reuse = options.tabMode === 'managed-reuse';
  const existing = await getManagedTabId();
  const token = new CancellationToken();
  let tabId: number;
  if (reuse && existing != null) {
    await chrome.tabs.update(existing, { url });
    tabId = existing;
  } else {
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id == null) throw new McpToolError('INTERNAL', '无法创建标签页');
    tabId = tab.id;
  }
  await setManagedTabId(tabId);
  const session = TabSession.attach(tabId, token);
  try {
    await session.waitComplete(45000, 600);
  } catch {
    /* 加载超时也返回当前 URL，让调用方自行 read-page 判断 */
  }
  const tab = await session.get().catch(() => null);
  return { tabId, finalUrl: tab?.url || url };
}

export interface ReadPageOptions {
  includeElements?: boolean;
  textMaxLength?: number;
  elementLimit?: number;
}

export async function mcpReadPage(options: ReadPageOptions = {}): Promise<Record<string, unknown>> {
  const state = await inject(await importSamplePageState(), []);
  if (!state) throw new McpToolError('VALIDATION_FAILED', '未能读取页面状态（页面可能拒绝注入）');
  const textMaxLength = Math.min(20000, Math.max(200, Number(options.textMaxLength) || 8000));
  const elementLimit = Math.min(200, Math.max(1, Number(options.elementLimit) || 40));
  return {
    url: state.url,
    title: state.title,
    textExcerpt: String(state.text || '').slice(0, textMaxLength),
    elements: options.includeElements === false ? [] : (state.elements || []).slice(0, elementLimit),
  };
}

async function waitForNewTab(openerTabId: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(null), timeoutMs);
    const listener = (tab: chrome.tabs.Tab) => {
      if (tab.openerTabId === openerTabId && tab.id != null) finish(tab.id);
    };
    const finish = (value: number | null) => {
      clearTimeout(timer);
      chrome.tabs.onCreated.removeListener(listener);
      resolve(value);
    };
    chrome.tabs.onCreated.addListener(listener);
  });
}

export interface ClickOptions {
  selector: string;
  watchPopup?: boolean;
  followPopup?: boolean;
  timeoutMs?: number;
}

export async function mcpClick(options: ClickOptions): Promise<Record<string, unknown>> {
  const selector = String(options.selector || '');
  if (!selector.trim()) throw new McpToolError('VALIDATION_FAILED', '缺少 selector');
  const timeoutMs = Math.min(120000, Math.max(1000, Number(options.timeoutMs) || 15000));
  return withBrowserLock(async () => {
    const { tabId } = await requireManagedTab();
    const watchPopup = options.watchPopup !== false;
    const popupPromise = watchPopup ? waitForNewTab(tabId, timeoutMs) : Promise.resolve(null);
    const before = await fingerprint();
    const mod = await import('../page/explorer-exec.js');
    const { session } = await requireManagedTab();
    const result = await session.inject(mod.execPageAction, [{ type: 'click', selector, timeoutMs }]);
    const newTabId = await popupPromise;
    if (newTabId != null && options.followPopup) await setManagedTabId(newTabId);
    let confirmed = newTabId != null;
    if (!confirmed) {
      try {
        confirmed = changedFingerprint(before, await fingerprint());
      } catch {
        confirmed = false;
      }
    }
    return {
      ok: result?.ok === true,
      confirmed,
      message: result?.message || '',
      evidence: result?.evidence ?? {},
      newTabId,
    };
  });
}

export interface TypeOptions {
  selector: string;
  text: string;
  timeoutMs?: number;
}

export async function mcpType(options: TypeOptions): Promise<Record<string, unknown>> {
  const selector = String(options.selector || '');
  if (!selector.trim()) throw new McpToolError('VALIDATION_FAILED', '缺少 selector');
  const timeoutMs = Math.min(120000, Math.max(1000, Number(options.timeoutMs) || 15000));
  return withBrowserLock(async () => {
    await assertNotPasswordField(selector);
    const before = await fingerprint();
    const mod = await import('../page/explorer-exec.js');
    const { session } = await requireManagedTab();
    const result = await session.inject(mod.execPageAction, [
      { type: 'type', selector, text: String(options.text ?? ''), timeoutMs },
    ]);
    const confirmed = result?.ok === true && changedFingerprint(before, await fingerprint());
    return {
      ok: result?.ok === true,
      confirmed,
      message: result?.message || '',
      evidence: result?.evidence ?? {},
      newTabId: null,
    };
  });
}

export async function mcpWait(ms: number): Promise<{ waitedMs: number }> {
  const waitedMs = Math.min(120000, Math.max(0, Number(ms) || 0));
  await new Promise((resolve) => setTimeout(resolve, waitedMs));
  return { waitedMs };
}

export interface WaitForTextOptions {
  selector?: string;
  includes: string;
  timeoutMs?: number;
}

export async function mcpWaitForText(options: WaitForTextOptions): Promise<{ found: boolean }> {
  const timeoutMs = Math.min(120000, Math.max(1000, Number(options.timeoutMs) || 15000));
  return withBrowserLock(async () => {
    const mod = await import('../page/explorer-exec.js');
    const { session } = await requireManagedTab();
    const result = await session.inject(mod.execPageAction, [
      {
        type: 'waitForText',
        selector: String(options.selector || ''),
        includes: String(options.includes ?? ''),
        timeoutMs,
      },
    ]);
    if (result?.ok !== true) {
      throw new McpToolError('EXECUTION_TIMEOUT', result?.message || `等待文本超时：${options.includes}`, true);
    }
    return { found: true };
  });
}

export interface WaitForUrlOptions {
  match: string;
  timeoutMs?: number;
}

export async function mcpWaitForUrl(options: WaitForUrlOptions): Promise<{ matched: boolean; url: string }> {
  const match = String(options.match || '');
  if (!match) throw new McpToolError('VALIDATION_FAILED', '缺少 match');
  const timeoutMs = Math.min(120000, Math.max(1000, Number(options.timeoutMs) || 30000));
  return withBrowserLock(async () => {
    const tester = buildMatcher(match);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { session } = await requireManagedTab();
      const tab = await session.get();
      if (tab.url && tester(tab.url)) return { matched: true, url: tab.url };
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new McpToolError('EXECUTION_TIMEOUT', `等待 URL 超时：${match}`, true);
  });
}

export interface ExtractOptions {
  selector: string;
  mode?: 'text' | 'attribute' | 'html' | 'value' | 'list' | 'table';
  attribute?: string;
  multiple?: boolean;
}

export async function mcpExtract(options: ExtractOptions): Promise<Record<string, unknown>> {
  const selector = String(options.selector || '').trim();
  if (!selector) throw new McpToolError('VALIDATION_FAILED', '缺少 selector');
  const mode = options.mode || 'text';
  if (mode === 'attribute' && !String(options.attribute || '').trim()) {
    throw new McpToolError('VALIDATION_FAILED', 'attribute 模式必须提供 attribute 属性名');
  }
  return withBrowserLock(async () => {
    const mod = await import('../page/extract.js');
    const { session } = await requireManagedTab();
    const result = await session.inject(mod.pageExtractData, [
      {
        selector,
        mode,
        attribute: String(options.attribute || ''),
        multiple: options.multiple !== false,
      },
    ]);
    if (!result?.ok) throw new McpToolError('NOT_FOUND', result?.message || '未提取到数据');
    return { count: result.count, data: result.data ?? null };
  });
}

export async function mcpCloseTab(): Promise<{ closed: boolean }> {
  return withBrowserLock(async () => {
    const tabId = await getManagedTabId();
    if (tabId == null) return { closed: false };
    await chrome.tabs.remove(tabId).catch(() => undefined);
    await setManagedTabId(null);
    return { closed: true };
  });
}
