/**
 * TabSession：封装一个被操作标签页的常用操作。
 * 统一 runner / recorder / explorer 三处重复的 waitTabComplete 与注入逻辑，
 * 中止/超时由 CancellationToken 驱动。
 */

import { TabGoneError } from './errors.js';
import { CancellationToken } from './cancellation.js';
import { getPageTextSample } from './cf.js';

/** 构造 URL 匹配器：/regex/flags → 正则；否则子串包含 */
export function buildMatcher(match: string | undefined | null): (url: string) => boolean {
  const m = String(match || '');
  if (m.length >= 2 && m.startsWith('/') && m.lastIndexOf('/') > 0) {
    const last = m.lastIndexOf('/');
    try {
      const re = new RegExp(m.slice(1, last), m.slice(last + 1));
      return (url: string) => re.test(url);
    } catch {
      /* fallthrough */
    }
  }
  return (url: string) => url.includes(m);
}

export class TabSession {
  private constructor(
    readonly id: number,
    private readonly token: CancellationToken
  ) {}

  /** 打开一个新标签并返回会话 */
  static async create(
    createProps: chrome.tabs.CreateProperties,
    token: CancellationToken
  ): Promise<TabSession> {
    const tab = await chrome.tabs.create(createProps);
    if (tab.id == null) throw new TabGoneError('无法创建标签页');
    return new TabSession(tab.id, token);
  }

  /** 接管已经由页面打开的子标签页；不会再次创建标签。 */
  static attach(tabId: number, token: CancellationToken): TabSession {
    return new TabSession(tabId, token);
  }

  /** 标签是否仍存在 */
  async exists(): Promise<boolean> {
    try {
      await chrome.tabs.get(this.id);
      return true;
    } catch {
      return false;
    }
  }

  /** 存活检查：标签已关则抛 TabGoneError */
  async assertAlive(): Promise<void> {
    try {
      await chrome.tabs.get(this.id);
    } catch {
      throw new TabGoneError('标签页已关闭（请勿中途关掉目标页，或点「强制停止」后重试）');
    }
  }

  async get(): Promise<chrome.tabs.Tab> {
    try {
      return await chrome.tabs.get(this.id);
    } catch {
      throw new TabGoneError();
    }
  }

  get url(): Promise<string> {
    return this.get().then((t) => t.url || t.pendingUrl || '');
  }

  async focus(): Promise<void> {
    try {
      await chrome.tabs.update(this.id, { active: true });
    } catch {
      /* ignore */
    }
  }

  async close(): Promise<void> {
    try {
      await chrome.tabs.remove(this.id);
    } catch {
      /* 可能已被用户关掉 */
    }
  }

  /**
   * 注入一个自包含函数到页面 isolated world 执行。
   * 标签已关时抛 TabGoneError（区别于普通注入失败）。
   */
  async inject<TArgs extends unknown[], R>(
    func: (...args: TArgs) => R,
    args?: TArgs
  ): Promise<R> {
    try {
      const injections = await chrome.scripting.executeScript({
        target: { tabId: this.id },
        func,
        args: args as TArgs,
      });
      const first = injections[0] as { result?: R } | undefined;
      return first?.result as R;
    } catch (e) {
      if (!(await this.exists())) throw new TabGoneError();
      throw e;
    }
  }

  /** 读取页面可见文本；注入失败返回 null（区别于「页面真空」的空串） */
  async getText(): Promise<string | null> {
    try {
      return await this.inject(getPageTextSample);
    } catch {
      if (this.token.isAborted || !(await this.exists())) return null;
      return null;
    }
  }

  /** 等待标签加载到 complete；中止/关标签/超时分别抛对应错误 */
  async waitComplete(timeoutMs: number, settleMs = 600): Promise<void> {
    const start = Date.now();
    // 若已 complete，短暂 settle 后返回
    try {
      const tab = await chrome.tabs.get(this.id);
      if (tab.status === 'complete') {
        await this.token.sleep(500);
        return;
      }
    } catch {
      throw new TabGoneError();
    }

    while (Date.now() - start < timeoutMs) {
      this.token.check();
      try {
        const t = await chrome.tabs.get(this.id);
        if (t.status === 'complete') {
          await this.token.sleep(settleMs);
          return;
        }
      } catch {
        throw new TabGoneError();
      }
      await this.token.sleep(300);
    }
    throw new Error(`页面加载超时（${timeoutMs}ms）`);
  }

  /** 等待当前标签 URL 包含 match（或匹配 /regex/） */
  async waitUrl(match: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    const tester = buildMatcher(match);
    while (Date.now() - start < timeoutMs) {
      const tab = await this.get();
      if (tab.url && tester(tab.url)) return;
      await this.token.sleep(400);
    }
    throw new Error(`等待 URL 超时：${match}`);
  }
}
