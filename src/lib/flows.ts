/**
 * 流程（Flow）持久化。
 * 一个 Flow = 画布上的节点图（nodes + edges），其中节点可以引用技能（Procedure），
 * 也可以是控制节点（开始、结束、条件、循环、并行、延时、变量等）。
 *
 * 执行引擎在 React Flow 画布页内（entrypoints/canvas/execution.ts），因为流程运行需要实时高亮节点、
 * 展示变量与日志；这里只负责存取。
 */

import { uid, type Flow } from './models.js';

const STORAGE_KEY = 'flows';

export function createFlow(partial: Partial<Flow> = {}): Flow {
  const now = Date.now();
  return {
    id: uid('flow'),
    name: '新流程',
    description: '',
    nodes: [],
    edges: [],
    variables: {},
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

async function readAll(): Promise<Flow[]> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? (data[STORAGE_KEY] as Flow[]) : [];
}

async function writeAll(list: Flow[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: list });
}

export async function getFlows(): Promise<Flow[]> {
  return readAll();
}

export async function saveFlow(flow: Flow): Promise<Flow> {
  const list = await readAll();
  const idx = list.findIndex((f) => f.id === flow.id);
  flow.updatedAt = Date.now();
  if (!flow.createdAt) flow.createdAt = flow.updatedAt;
  if (idx >= 0) list[idx] = flow;
  else list.push(flow);
  await writeAll(list);
  return flow;
}

export async function deleteFlow(id: string): Promise<void> {
  const list = (await readAll()).filter((f) => f.id !== id);
  await writeAll(list);
}
