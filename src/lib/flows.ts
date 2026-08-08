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
  const hasCustomNodes = Array.isArray(partial.nodes) && partial.nodes.length > 0;
  let nodes: Flow['nodes'];
  let edges: Flow['edges'];
  if (hasCustomNodes) {
    nodes = partial.nodes!;
    edges = partial.edges ?? [];
  } else {
    const startId = uid('node');
    const endId = uid('node');
    nodes = [
      { id: startId, type: 'start', x: 80, y: 200, data: {} },
      { id: endId, type: 'end', x: 500, y: 200, data: {} },
    ];
    edges = [{ id: uid('edge'), from: startId, to: endId, when: 'always' }];
  }
  return {
    id: uid('flow'),
    name: '新流程',
    description: '',
    variables: {},
    createdAt: now,
    updatedAt: now,
    ...partial,
    // 不传入 nodes/edges 时必须得到可直接运行的开始 → 结束骨架。
    nodes,
    edges,
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
  const list = await readAll();
  let changed = false;
  const normalized = list.map((flow) => {
    const next = ensureDefaultGraph(flow);
    if (next !== flow) changed = true;
    return next;
  });
  if (changed) await writeAll(normalized);
  return normalized;
}

export async function saveFlow(flow: Flow): Promise<Flow> {
  flow = ensureDefaultGraph(flow);
  const list = await readAll();
  const idx = list.findIndex((f) => f.id === flow.id);
  flow.updatedAt = Date.now();
  if (!flow.createdAt) flow.createdAt = flow.updatedAt;
  if (idx >= 0) list[idx] = flow;
  else list.push(flow);
  await writeAll(list);
  return flow;
}

/** 修复早期由管理页创建、但尚未进入画布编辑的空流程。 */
function ensureDefaultGraph(flow: Flow): Flow {
  if (Array.isArray(flow.nodes) && flow.nodes.length > 0) return flow;
  const scaffold = createFlow();
  return { ...flow, nodes: scaffold.nodes, edges: scaffold.edges };
}

export async function deleteFlow(id: string): Promise<void> {
  const list = (await readAll()).filter((f) => f.id !== id);
  await writeAll(list);
}
