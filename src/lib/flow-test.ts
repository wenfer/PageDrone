/**
 * 通过现有 React Flow 画布执行一次流程诊断。
 *
 * 流程的执行引擎仍然在 entrypoints/canvas/execution.ts；这里仅负责打开一个
 * 隔离的画布标签、等待画布回传报告，以及把诊断过程转给 AI 对话进度。
 */

import { getFlows } from './flows.js';
import { CancellationToken } from './cancellation.js';
import type { FlowTestReport } from './types.js';

interface PendingFlowTest {
  resolve: (report: FlowTestReport) => void;
  onProgress?: (message: string) => void;
}

const pending = new Map<string, PendingFlowTest>();

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Service Worker 收到画布完成消息后调用。 */
export function resolveFlowTestResult(requestId: string, report: FlowTestReport): boolean {
  const item = pending.get(requestId);
  if (!item) return false;
  pending.delete(requestId);
  item.resolve({ ...report, requestId });
  return true;
}

/** Service Worker 收到画布实时日志后调用。 */
export function reportFlowTestProgress(requestId: string, message: string): boolean {
  const item = pending.get(requestId);
  if (!item) return false;
  item.onProgress?.(String(message || ''));
  return true;
}

/**
 * 打开隔离的画布标签并执行指定流程。标签由 finally 关闭，避免 AI 测试留下
 * 多余页面；执行中的页面观察会先由画布转成进度，最终随流程日志一起回传。
 */
export async function runFlowTest(
  flowId: string,
  signal: CancellationToken,
  onProgress?: (message: string) => void,
): Promise<FlowTestReport> {
  const flow = (await getFlows()).find((item) => item.id === flowId);
  if (!flow) throw new Error(`流程 ${flowId} 不存在，请先用现有流程列表获取真实 id`);

  const requestId = uid('flow_test');
  const reportPromise = new Promise<FlowTestReport>((resolve) => {
    pending.set(requestId, { resolve, onProgress });
  });
  let tabId: number | undefined;
  try {
    const url = new URL(chrome.runtime.getURL('canvas.html'));
    url.searchParams.set('flowId', flowId);
    url.searchParams.set('autorun', '1');
    url.searchParams.set('diagnostic', '1');
    url.searchParams.set('requestId', requestId);
    const tab = await chrome.tabs.create({ url: url.toString(), active: false });
    tabId = tab.id == null ? undefined : tab.id;
    if (tabId == null) throw new Error('无法打开流程诊断画布');

    while (true) {
      signal.check();
      const result = await Promise.race([
        reportPromise,
        signal.sleep(250).then(() => null),
      ]);
      if (result) return result;
    }
  } finally {
    pending.delete(requestId);
    if (tabId != null) await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}
