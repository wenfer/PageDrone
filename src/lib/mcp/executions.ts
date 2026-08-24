/**
 * MCP 异步作业模型：run-* 立即返回 executionId，进度与终态全量持久化，
 * SW 冷启动后仍可应答 get-execution；取消复用 abortStandaloneRun / stopQueue / CancellationToken。
 */

import { RUN_STATE } from '../messaging.js';
import { abortStandaloneRun } from '../run-context.js';
import { stopQueue } from '../execution-queue.js';
import { abortExploration } from '../explorer.js';
import { CancellationToken } from '../cancellation.js';
import type { RunState } from '../messaging.js';
import type { McpErrorCode } from './errors.js';

const EXECUTIONS_KEY = 'mcpExecutions';
const MAX_EXECUTIONS = 60;

export type McpExecutionKind = 'run-all' | 'run-site' | 'run-procedure' | 'run-flow' | 'explore';
export type McpExecutionState = 'queued' | 'running' | 'waiting_cf' | 'need_manual' | 'done' | 'aborted';

export interface McpProgressEvent {
  at: number;
  message: string;
}

export interface McpExecutionRecord {
  id: string;
  kind: McpExecutionKind;
  label: string;
  state: McpExecutionState;
  progress: McpProgressEvent[];
  result?: Record<string, unknown>;
  errorCode?: McpErrorCode;
  createdAt: number;
  finishedAt?: number;
}

// 内存态：取消令牌（流程/探索）与长轮询等待者；记录本体始终落盘
const flowTokens = new Map<string, CancellationToken>();
const waiters = new Map<string, Set<() => void>>();
const cache = new Map<string, McpExecutionRecord>();

// 进度外推钩子：由 session 层注册（转发 notifications/progress），
// 避免 executions ↔ session 循环依赖。
type ExecutionProgressHook = (record: McpExecutionRecord) => void;
let progressHook: ExecutionProgressHook | null = null;
export function setExecutionProgressHook(fn: ExecutionProgressHook | null): void {
  progressHook = fn;
}

function newId(): string {
  return `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function loadAll(): Promise<McpExecutionRecord[]> {
  const data = await chrome.storage.local.get(EXECUTIONS_KEY);
  const list = Array.isArray(data[EXECUTIONS_KEY]) ? (data[EXECUTIONS_KEY] as McpExecutionRecord[]) : [];
  return list;
}

async function persist(list: McpExecutionRecord[]): Promise<void> {
  await chrome.storage.local.set({ [EXECUTIONS_KEY]: list.slice(0, MAX_EXECUTIONS) });
}

async function saveRecord(record: McpExecutionRecord): Promise<void> {
  cache.set(record.id, record);
  const rest = (await loadAll()).filter((item) => item.id !== record.id);
  await persist([record, ...rest]);
  const listeners = waiters.get(record.id);
  if (listeners) {
    for (const notify of listeners) notify();
  }
  progressHook?.(record);
}

/** 创建作业（queued），由调用方紧接着把状态推进到 running */
export async function createMcpExecution(kind: McpExecutionKind, label: string): Promise<string> {
  const id = newId();
  const record: McpExecutionRecord = {
    id,
    kind,
    label,
    state: 'queued',
    progress: [],
    createdAt: Date.now(),
  };
  await saveRecord(record);
  return id;
}

export async function updateMcpExecution(
  id: string,
  patch: Partial<Pick<McpExecutionRecord, 'state' | 'label'>>,
  progressMessage?: string,
): Promise<void> {
  const record = cache.get(id) ?? (await loadAll()).find((item) => item.id === id);
  if (!record) return;
  record.state = patch.state ?? record.state;
  if (patch.label !== undefined) record.label = patch.label;
  if (progressMessage) {
    record.progress = [...record.progress.slice(-49), { at: Date.now(), message: progressMessage }];
  }
  await saveRecord(record);
}

export async function finishMcpExecution(
  id: string,
  result: Record<string, unknown>,
  options: { aborted?: boolean; errorCode?: McpErrorCode; message?: string } = {},
): Promise<void> {
  const record = cache.get(id) ?? (await loadAll()).find((item) => item.id === id);
  if (!record) return;
  record.state = options.aborted ? 'aborted' : 'done';
  record.finishedAt = Date.now();
  record.result = result;
  if (options.errorCode) record.errorCode = options.errorCode;
  if (options.message) record.result.message = options.message;
  flowTokens.delete(id);
  await saveRecord(record);
}

export async function getMcpExecution(id: string): Promise<McpExecutionRecord | null> {
  const cached = cache.get(id);
  if (cached) return cached;
  const found = (await loadAll()).find((item) => item.id === id) || null;
  if (found) cache.set(id, found);
  return found;
}

/** 长轮询：waitMs>0 时阻塞至终态或超时 */
export async function waitMcpExecution(id: string, waitMs: number): Promise<McpExecutionRecord | null> {
  let record = await getMcpExecution(id);
  if (!record) return null;
  const terminal = (item: McpExecutionRecord) =>
    item.state === 'done' || item.state === 'aborted';
  if (terminal(record) || waitMs <= 0) return record;
  const deadline = Date.now() + Math.min(300000, waitMs);
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const listeners = waiters.get(id) ?? new Set();
      listeners.add(resolve);
      waiters.set(id, listeners);
      setTimeout(resolve, 500);
    });
    record = await getMcpExecution(id);
    if (!record || terminal(record)) return record;
  }
  return record;
}

export function registerFlowToken(id: string, token: CancellationToken): void {
  flowTokens.set(id, token);
}

/** 取消作业：按类型路由到既有取消链路 */
export async function abortMcpExecution(id: string): Promise<{ aborted: boolean; reason?: string }> {
  const record = await getMcpExecution(id);
  if (!record) return { aborted: false, reason: `executionId ${id} 不存在` };
  if (record.state === 'done' || record.state === 'aborted') {
    return { aborted: false, reason: `作业已结束（${record.state}）` };
  }
  let ok = true;
  switch (record.kind) {
    case 'run-procedure':
      ok = abortStandaloneRun(id);
      break;
    case 'run-all':
    case 'run-site':
      await stopQueue('MCP 客户端请求取消');
      break;
    case 'run-flow':
      flowTokens.get(id)?.abort();
      break;
    case 'explore':
      abortExploration();
      break;
  }
  // 底层运行结束时会写终态；这里兜底标记，避免底层已丢失时作业永远悬挂
  if (record.kind === 'run-procedure' && !ok) {
    await finishMcpExecution(id, { ok: false, status: 'aborted', message: '已取消（执行实例不存在或已结束）' }, { aborted: true });
  }
  return { aborted: true };
}

/** 把全局队列的 RunState 映射为作业状态（run-all / run-site 监控用） */
export function mapRunState(state: RunState): McpExecutionState {
  switch (state) {
    case RUN_STATE.RUNNING:
      return 'running';
    case RUN_STATE.WAITING_CF:
      return 'waiting_cf';
    case RUN_STATE.NEED_MANUAL:
    case RUN_STATE.NEED_INTERVENTION:
      return 'need_manual';
    default:
      return 'done';
  }
}
