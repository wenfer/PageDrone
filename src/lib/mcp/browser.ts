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

async function importSamplePageOutline() {
  const mod = await import('../page/outline.js');
  return mod.samplePageOutline;
}

// —— 原语实现 ——

export interface NavigateOptions {
  url?: string;
  tabMode?: 'managed-new' | 'managed-reuse' | 'current-active';
}

export async function mcpNavigate(options: NavigateOptions): Promise<{ tabId: number; finalUrl: string }> {
  const rawUrl = options.url ? String(options.url).trim() : '';
  const parsed = rawUrl ? assertSafeHttpUrl(rawUrl) : null;
  const url = parsed ? parsed.toString() : '';
  const mode = options.tabMode || 'managed-new';
  const existing = await getManagedTabId();
  const token = new CancellationToken();
  let tabId: number;

  if (mode === 'current-active') {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeTab = tabs[0] || (await chrome.tabs.query({ active: true }))[0];
    if (!activeTab || activeTab.id == null) {
      throw new McpToolError('NOT_FOUND', '未找到当前活动标签页');
    }
    tabId = activeTab.id;
    if (url && activeTab.url !== url) {
      await chrome.tabs.update(tabId, { url });
    }
  } else if (mode === 'managed-reuse' && existing != null) {
    if (url) {
      await chrome.tabs.update(existing, { url });
    }
    tabId = existing;
  } else {
    if (!url) {
      throw new McpToolError('VALIDATION_FAILED', '创建新标签页必须提供 url');
    }
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
  return { tabId, finalUrl: tab?.url || url || '' };
}

export interface ReadPageOptions {
  includeElements?: boolean;
  textMaxLength?: number;
  elementLimit?: number;
  inViewportOnly?: boolean;
  format?: 'detailed' | 'compact' | 'elements_only';
  selectorScope?: string;
}

export async function mcpReadPage(options: ReadPageOptions = {}): Promise<Record<string, unknown>> {
  const sampleFunc = await importSamplePageState();
  const state = await inject(sampleFunc, [{
    includeElements: options.includeElements !== false,
    textMaxLength: typeof options.textMaxLength === 'number' ? options.textMaxLength : 2000,
    elementLimit: typeof options.elementLimit === 'number' ? options.elementLimit : 50,
    inViewportOnly: options.inViewportOnly === true,
    format: options.format || 'detailed',
    selectorScope: options.selectorScope,
  }]);

  if (!state) throw new McpToolError('VALIDATION_FAILED', '未能读取页面状态（页面可能拒绝注入）');

  if (options.format === 'compact') {
    return {
      url: state.url,
      title: state.title,
      viewport: state.viewport,
      compactView: state.compactView || '',
      elementCount: state.elements.length,
    };
  }

  if (options.format === 'elements_only') {
    return {
      url: state.url,
      elements: state.elements,
      compactView: state.compactView || '',
    };
  }

  return {
    url: state.url,
    title: state.title,
    textExcerpt: state.text,
    viewport: state.viewport,
    compactView: state.compactView,
    elements: state.elements,
  };
}

export interface ScreenshotOptions {
  selector?: string;
  format?: 'png' | 'jpeg';
  quality?: number;
}

export async function mcpScreenshot(options: ScreenshotOptions = {}): Promise<Record<string, unknown>> {
  return withBrowserLock(async () => {
    const { tabId } = await requireManagedTab();
    const tab = await chrome.tabs.get(tabId);
    const windowId = tab.windowId;

    const format = options.format === 'jpeg' ? 'jpeg' : 'png';
    const quality = format === 'jpeg' ? Math.min(100, Math.max(1, Number(options.quality) || 80)) : undefined;

    let dataUrl: string;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format,
        ...(quality !== undefined ? { quality } : {}),
      });
    } catch (e) {
      throw new McpToolError('INTERNAL', `截图失败：${(e as Error)?.message || String(e)}`);
    }

    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const base64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/, '');

    let elementRect: Record<string, unknown> | null = null;
    if (options.selector) {
      try {
        const { session } = await requireManagedTab();
        elementRect = await session.inject((sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        }, [options.selector]);
      } catch {
        elementRect = null;
      }
    }

    return {
      mimeType,
      base64,
      dataUrl,
      tabId,
      url: tab.url || '',
      title: tab.title || '',
      elementRect,
      __mcpImage: {
        data: base64,
        mimeType,
      },
    };
  });
}

// —— 标签页与导航控制 ——

export async function mcpListTabs(): Promise<Record<string, unknown>> {
  const currentManagedId = await getManagedTabId();
  const tabs = await chrome.tabs.query({});
  const list = tabs.map((t) => ({
    id: t.id,
    title: t.title || '',
    url: t.url || '',
    active: !!t.active,
    managed: t.id === currentManagedId,
    windowId: t.windowId,
  }));
  return {
    tabs: list,
    managedTabId: currentManagedId,
    total: list.length,
  };
}

export async function mcpSwitchTab(tabId: number): Promise<{ tabId: number; url: string; title: string }> {
  if (typeof tabId !== 'number') throw new McpToolError('VALIDATION_FAILED', 'tabId 必须为数字');
  try {
    const tab = await chrome.tabs.get(tabId);
    await setManagedTabId(tabId);
    await chrome.tabs.update(tabId, { active: true });
    return { tabId, url: tab.url || '', title: tab.title || '' };
  } catch (e) {
    throw new McpToolError('NOT_FOUND', `标签页 ${tabId} 不存在或已关闭`);
  }
}

export async function mcpNewTab(options: { url: string }): Promise<{ tabId: number; url: string }> {
  const parsed = assertSafeHttpUrl(options.url);
  const url = parsed.toString();
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab.id == null) throw new McpToolError('INTERNAL', '无法创建新标签页');
  await setManagedTabId(tab.id);
  const token = new CancellationToken();
  const session = TabSession.attach(tab.id, token);
  try {
    await session.waitComplete(45000, 600);
  } catch {
    /* 加载超时忽略 */
  }
  return { tabId: tab.id, url };
}

export async function mcpGoBack(): Promise<{ success: boolean; url: string }> {
  return withBrowserLock(async () => {
    const { tabId, session } = await requireManagedTab();
    await chrome.tabs.goBack(tabId);
    await session.waitComplete(15000, 400).catch(() => undefined);
    const tab = await session.get().catch(() => null);
    return { success: true, url: tab?.url || '' };
  });
}

export async function mcpGoForward(): Promise<{ success: boolean; url: string }> {
  return withBrowserLock(async () => {
    const { tabId, session } = await requireManagedTab();
    await chrome.tabs.goForward(tabId);
    await session.waitComplete(15000, 400).catch(() => undefined);
    const tab = await session.get().catch(() => null);
    return { success: true, url: tab?.url || '' };
  });
}

export async function mcpReloadPage(options: { ignoreCache?: boolean } = {}): Promise<{ reloaded: boolean; url: string }> {
  return withBrowserLock(async () => {
    const { tabId, session } = await requireManagedTab();
    await chrome.tabs.reload(tabId, { bypassCache: !!options.ignoreCache });
    await session.waitComplete(25000, 500).catch(() => undefined);
    const tab = await session.get().catch(() => null);
    return { reloaded: true, url: tab?.url || '' };
  });
}

export async function mcpGetPageOutline(): Promise<Record<string, unknown>> {
  const outlineFunc = await importSamplePageOutline();
  const outline = await inject(outlineFunc, []);
  if (!outline) throw new McpToolError('VALIDATION_FAILED', '未能提取页面大纲');
  return outline as unknown as Record<string, unknown>;
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

export interface HoverOptions {
  selector: string;
  timeoutMs?: number;
}

export async function mcpHover(options: HoverOptions): Promise<Record<string, unknown>> {
  const selector = String(options.selector || '');
  if (!selector.trim()) throw new McpToolError('VALIDATION_FAILED', '缺少 selector');
  const timeoutMs = Math.min(120000, Math.max(1000, Number(options.timeoutMs) || 10000));
  return withBrowserLock(async () => {
    const mod = await import('../page/explorer-exec.js');
    const { session } = await requireManagedTab();
    const result = await session.inject(mod.execPageAction, [{ type: 'hover', selector, timeoutMs }]);
    return {
      ok: result?.ok === true,
      message: result?.message || '',
      evidence: result?.evidence ?? {},
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

export async function mcpClearInput(options: { selector: string }): Promise<Record<string, unknown>> {
  const selector = String(options.selector || '');
  if (!selector.trim()) throw new McpToolError('VALIDATION_FAILED', '缺少 selector');
  return withBrowserLock(async () => {
    const mod = await import('../page/explorer-exec.js');
    const { session } = await requireManagedTab();
    const result = await session.inject(mod.execPageAction, [{ type: 'clear', selector }]);
    return {
      ok: result?.ok === true,
      message: result?.message || '',
      evidence: result?.evidence ?? {},
    };
  });
}

export interface PressKeyOptions {
  key: string;
  selector?: string;
  modifiers?: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean };
}

export async function mcpPressKey(options: PressKeyOptions): Promise<Record<string, unknown>> {
  const key = String(options.key || 'Enter').trim();
  return withBrowserLock(async () => {
    const mod = await import('../page/explorer-exec.js');
    const { session } = await requireManagedTab();
    const result = await session.inject(mod.execPageAction, [{
      type: 'pressKey',
      key,
      selector: options.selector,
      modifiers: options.modifiers,
    }]);
    return {
      ok: result?.ok === true,
      message: result?.message || '',
      evidence: result?.evidence ?? {},
    };
  });
}

export interface ScrollPageOptions {
  direction?: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom' | 'toElement';
  distance?: number;
  selector?: string;
}

export async function mcpScrollPage(options: ScrollPageOptions = {}): Promise<Record<string, unknown>> {
  return withBrowserLock(async () => {
    const mod = await import('../page/explorer-exec.js');
    const { session } = await requireManagedTab();
    const result = await session.inject(mod.execPageAction, [{
      type: 'scroll',
      direction: options.direction || 'down',
      distance: options.distance,
      selector: options.selector,
    }]);
    return {
      ok: result?.ok === true,
      message: result?.message || '',
      evidence: result?.evidence ?? {},
    };
  });
}

export interface SelectOptionOptions {
  selector: string;
  value?: string;
  label?: string;
  index?: number;
}

export async function mcpSelectOption(options: SelectOptionOptions): Promise<Record<string, unknown>> {
  const selector = String(options.selector || '').trim();
  if (!selector) throw new McpToolError('VALIDATION_FAILED', '缺少 selector');
  return withBrowserLock(async () => {
    const mod = await import('../page/explorer-exec.js');
    const { session } = await requireManagedTab();
    const result = await session.inject(mod.execPageAction, [{
      type: 'selectOption',
      selector,
      value: options.value,
      label: options.label,
      index: options.index,
    }]);
    return {
      ok: result?.ok === true,
      message: result?.message || '',
      evidence: result?.evidence ?? {},
    };
  });
}

export interface ClickCoordinateOptions {
  x: number;
  y: number;
}

export async function mcpClickCoordinate(options: ClickCoordinateOptions): Promise<Record<string, unknown>> {
  if (typeof options.x !== 'number' || typeof options.y !== 'number') {
    throw new McpToolError('VALIDATION_FAILED', 'x 和 y 必须为数字坐标');
  }
  return withBrowserLock(async () => {
    const mod = await import('../page/explorer-exec.js');
    const { session } = await requireManagedTab();
    const result = await session.inject(mod.execPageAction, [{
      type: 'clickCoordinate',
      x: options.x,
      y: options.y,
    }]);
    return {
      ok: result?.ok === true,
      message: result?.message || '',
      evidence: result?.evidence ?? {},
    };
  });
}

export interface BatchActionItem {
  type: string;
  selector?: string;
  text?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom' | 'toElement';
  distance?: number;
  value?: string;
  label?: string;
  index?: number;
  x?: number;
  y?: number;
  ms?: number;
  timeoutMs?: number;
}

export interface BatchActionsOptions {
  actions: BatchActionItem[];
  stopOnError?: boolean;
}

export async function mcpBatchActions(options: BatchActionsOptions): Promise<Record<string, unknown>> {
  const actions = Array.isArray(options.actions) ? options.actions : [];
  if (!actions.length) throw new McpToolError('VALIDATION_FAILED', 'actions 数组不能为空');

  return withBrowserLock(async () => {
    const results: Array<Record<string, unknown>> = [];
    const mod = await import('../page/explorer-exec.js');
    const { session } = await requireManagedTab();

    for (let i = 0; i < actions.length; i++) {
      const act = actions[i];
      if (!act) continue;
      if (act.type === 'wait') {
        const ms = Math.min(30000, Math.max(0, Number(act.ms) || 500));
        await new Promise((r) => setTimeout(r, ms));
        results.push({ index: i, type: 'wait', ok: true, waitedMs: ms });
        continue;
      }
      if (act.type === 'type' && act.selector) {
        await assertNotPasswordField(act.selector);
      }
      const res = await session.inject(mod.execPageAction, [act as unknown as Parameters<typeof mod.execPageAction>[0]]);
      results.push({ index: i, type: act.type, ok: res?.ok === true, message: res?.message, evidence: res?.evidence });
      if (res?.ok !== true && options.stopOnError !== false) {
        return {
          ok: false,
          stoppedAtIndex: i,
          message: `批量动作在第 ${i + 1} 步中断：${res?.message || '未知错误'}`,
          results,
        };
      }
    }

    return {
      ok: true,
      total: actions.length,
      message: `成功执行 ${actions.length} 个批量动作`,
      results,
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
