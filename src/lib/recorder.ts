/**
 * 录制引擎（Record & Induction Engine）
 *
 * 与 explorer.ts 互补的另一条「技能生成」路径：
 *   - explorer.ts：LLM 自主探索，归纳确定性步骤
 *   - recorder.ts：用户亲手操作，采集器把操作翻译成确定性步骤
 */

import { TabSession } from './tab-session.js';
import { CancellationToken } from './cancellation.js';
import { setRuntime } from './storage.js';
import { RUN_STATE } from './messaging.js';
import { pageCollector } from './page/collector.js';
import type { RecordingPreview } from './types.js';

// 录制期间的步骤不参与 Step 判别联合的严格检查——
// 它处于编辑态（_preview 临时字段），最终由 saveProcedure 以 Partial 形式入库。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RecStep = Record<string, any> & { _preview?: string };

export class RecordingSession {
  private readonly tab: TabSession;
  private mutableUrl: string;

  steps: RecStep[] = [];
  lastClickAt = 0;
  onUpdated: ((tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => void) | null = null;
  onRemoved: ((tabId: number) => void) | null = null;
  private pending: { steps: RecStep[]; reason: string; at: number } | null = null;

  private constructor(tab: TabSession, url: string) {
    this.tab = tab;
    this.mutableUrl = url;
  }

  static async create(url: string, signal: CancellationToken): Promise<RecordingSession> {
    if (!url || !/^https?:\/\//i.test(url)) throw new Error('请提供合法的 http(s) 目标网址');

    const tab = await TabSession.create({ url, active: true }, signal);
    const session = new RecordingSession(tab, url);

    await setRuntime({
      state: RUN_STATE.RECORDING,
      message: '录制中，请在打开的页面上操作…',
      recordingSteps: [],
      recordingResult: undefined,
    });

    try {
      await tab.waitComplete(45000, 400);
    } catch {
      /* 尽力而为 */
    }
    await session.injectCollector();

    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tab.id) return;
      if (changeInfo.status === 'complete') {
        session.injectCollector().catch(() => {});
      }
      if (changeInfo.url && changeInfo.url !== session.mutableUrl) {
        const near = Date.now() - session.lastClickAt < 3500;
        const isInitial = session.steps.length === 0;
        if (!near && !isInitial) {
          session.pushStep(
            { type: 'goto', url: changeInfo.url, timeoutMs: 45000 },
            `跳转到 ${changeInfo.url}`
          );
        }
        session.mutableUrl = changeInfo.url;
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    session.onUpdated = onUpdated;

    const onRemoved = (closedTabId: number) => {
      if (closedTabId === tab.id) {
        chrome.tabs.onRemoved.removeListener(onRemoved);
        session.finalizeAsPending('标签页被关闭');
      }
    };
    chrome.tabs.onRemoved.addListener(onRemoved);
    session.onRemoved = onRemoved;

    return session;
  }

  get tabId(): number {
    return this.tab.id;
  }

  private async injectCollector(): Promise<void> {
    try {
      await this.tab.inject(pageCollector, []);
    } catch {
      /* 受限页，忽略 */
    }
  }

  handleEvent(
    event: { type: string; selector?: string; label?: string; navigates?: boolean; value?: string; masked?: boolean }
  ): { ok: boolean; ignored?: boolean; count?: number } {
    if (event.type === 'click') {
      this.lastClickAt = Date.now();
      this.pushStep(
        {
          type: 'click',
          selector: event.selector,
          timeoutMs: 15000,
          waitNavigation: !!event.navigates,
        },
        `点击 ${event.label || event.selector || ''}`
      );
    } else if (event.type === 'type') {
      const last = this.steps[this.steps.length - 1];
      if (last && last.type === 'type' && last.selector === event.selector) {
        last.text = event.value ?? '';
        last._preview = event.masked ? '（已输入密码）' : `输入「${(event.value || '').slice(0, 30)}」`;
        this.broadcast();
        return { ok: true };
      }
      this.pushStep(
        {
          type: 'type',
          selector: event.selector,
          text: event.value ?? '',
          timeoutMs: 10000,
        },
        event.masked
          ? '（已输入密码）'
          : `输入「${(event.value || '').slice(0, 30)}」到 ${event.label || event.selector || ''}`
      );
    } else {
      return { ok: false, ignored: true };
    }
    return { ok: true, count: this.steps.length };
  }

  private pushStep(step: RecStep, preview: string): void {
    this.steps.push({ ...step, _preview: preview });
    this.broadcast();
  }

  deleteStep(index: number): { ok: boolean; count: number } {
    if (index >= 0 && index < this.steps.length) {
      this.steps.splice(index, 1);
      this.broadcast();
    }
    return { ok: true, count: this.steps.length };
  }

  private broadcast(): void {
    const preview: RecordingPreview[] = this.steps.map((s, i) => ({
      index: i,
      type: String(s.type || ''),
      label: String(s._preview || s.selector || s.url || s.type || ''),
    }));
    void setRuntime({ recordingSteps: preview });
  }

  stop(): { ok: boolean; steps: RecStep[]; message: string } {
    if (this.steps.length === 0 && this.pending) {
      const { steps, reason } = this.pending;
      this.pending = null;
      return { ok: true, steps, message: `已录制 ${steps.length} 个步骤（${reason}）` };
    }
    return this.finalize('用户停止');
  }

  discard(): { ok: boolean; discarded: boolean } {
    const had = !!(this.steps.length || this.pending);
    this.steps = [];
    this.pending = null;
    this.finalize('用户放弃');
    return { ok: true, discarded: had };
  }

  private finalize(reason: string): { ok: boolean; steps: RecStep[]; message: string } {
    const { onUpdated, onRemoved, tab } = this;
    try {
      if (onUpdated) chrome.tabs.onUpdated.removeListener(onUpdated);
      if (onRemoved) chrome.tabs.onRemoved.removeListener(onRemoved);
    } catch {
      /* ignore */
    }
    tab
      .inject((): void => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__acRecording = false;
      })
      .catch(() => {});

    const steps = this.steps.map((s) => {
      const { _preview, ...clean } = s;
      return clean;
    });
    const result = { ok: true, steps, message: `已录制 ${steps.length} 个步骤（${reason}）` };
    void setRuntime({
      state: RUN_STATE.IDLE,
      message: '录制结束',
      recordingResult: { ok: true, steps: steps.length, reason },
    });
    return result;
  }

  private finalizeAsPending(reason: string): void {
    const r = this.finalize(reason);
    if (r.ok && r.steps.length) {
      this.pending = { steps: r.steps, reason, at: Date.now() };
      void setRuntime({
        state: RUN_STATE.IDLE,
        message: `录制已中断（${reason}），${r.steps.length} 个步骤待保存`,
        recordingResult: { ok: true, steps: r.steps.length, reason, pending: true },
      });
    }
  }
}

// —— 模块级薄导出 ——

let session: RecordingSession | null = null;

export function isRecording(): boolean {
  return !!session;
}

export async function startRecording(url: string): Promise<{ ok: boolean; tabId: number }> {
  if (session) throw new Error('已有录制进行中，请先停止');
  const signal = new CancellationToken();
  const s = await RecordingSession.create(url, signal);
  session = s;
  return { ok: true, tabId: s.tabId };
}

export function handleRecordEvent(
  event: { type: string; selector?: string; label?: string; navigates?: boolean; value?: string; masked?: boolean },
  senderTabId?: number | null
): { ok: boolean; ignored?: boolean; count?: number } {
  if (!session) return { ok: false, ignored: true };
  // 采集器可能残留在别的标签页里，只认当前录制标签的事件
  if (senderTabId != null && senderTabId !== session.tabId) return { ok: false, ignored: true };
  return session.handleEvent(event);
}

export function removeRecordedStep(index: number): { ok: boolean; count: number } {
  if (!session) return { ok: false, count: 0 };
  return session.deleteStep(index);
}

export function stopRecording(): { ok: boolean; steps: RecStep[]; message: string } {
  if (!session) return { ok: false, steps: [], message: '当前没有录制会话' };
  const s = session;
  session = null;
  return s.stop();
}

export function discardRecording(): { ok: boolean; discarded: boolean } {
  if (!session) return { ok: true, discarded: false };
  const s = session;
  session = null;
  return s.discard();
}
