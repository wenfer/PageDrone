import { MarkerType, type Viewport } from '@xyflow/react';
import type {
  CanvasEdge,
  CanvasNode,
  EdgeWhen,
  FlowNodeData,
  FlowNodeKind,
  StoredFlow,
} from './types';

export const NODE_CATALOG: ReadonlyArray<{
  group: 'control' | 'browser';
  type: FlowNodeKind;
  label: string;
  icon: string;
}> = [
  { group: 'control', type: 'start', label: '开始', icon: '▶' },
  { group: 'control', type: 'end', label: '结束', icon: '■' },
  { group: 'control', type: 'condition', label: '条件分支', icon: '⑂' },
  { group: 'control', type: 'loop', label: '循环', icon: '↻' },
  { group: 'control', type: 'parallel', label: '并行', icon: '⇉' },
  { group: 'control', type: 'delay', label: '延时', icon: '◷' },
  { group: 'control', type: 'variable', label: '设置变量', icon: '▣' },
  { group: 'control', type: 'log', label: '记录日志', icon: '≡' },
  { group: 'browser', type: 'extract', label: '提取数据', icon: '⇩' },
  { group: 'browser', type: 'request', label: '发送请求', icon: '↗' },
  { group: 'browser', type: 'procedure', label: '调用技能', icon: '◇' },
  { group: 'browser', type: 'site', label: '执行站点', icon: '◎' },
];

export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

export function uid(prefix: 'flow' | 'n' | 'e'): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;
}

export function defaultNodeData(type: FlowNodeKind): FlowNodeData {
  switch (type) {
    case 'condition': return { expr: 'true' };
    case 'loop': return { count: 3, loopVar: 'i' };
    case 'delay': return { ms: 1000 };
    case 'variable': return { name: 'var1', value: '' };
    case 'log': return { level: 'info', message: '' };
    case 'extract': return {
      selector: 'body', mode: 'text', attribute: '', multiple: false, variable: 'extracted',
    };
    case 'request':
    case 'http': return {
      url: '', method: 'GET', headers: '', body: '', timeoutMs: 30000, variable: 'response',
    };
    case 'procedure': return { siteId: '', procedureId: '', url: '', params: {} };
    case 'site': return { siteId: '', force: false };
    default: return {};
  }
}

export function newStoredFlow(index: number): StoredFlow {
  const now = Date.now();
  const startId = uid('n');
  const endId = uid('n');
  return {
    id: uid('flow'),
    name: `新流程 ${index}`,
    description: '',
    nodes: [
      { id: startId, type: 'start', x: 80, y: 200, data: {} },
      { id: endId, type: 'end', x: 500, y: 200, data: {} },
    ],
    edges: [{ id: uid('e'), from: startId, to: endId, when: 'always' }],
    variables: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function toCanvas(flow: StoredFlow): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes = flow.nodes.map<CanvasNode>((node) => ({
    id: node.id,
    // 早期开发快照曾把发送请求节点保存为 http；加载时规范化为 request，
    // 避免 React Flow 找不到未注册的旧节点渲染器。
    type: node.type === 'http' ? 'request' : isNodeKind(node.type) ? node.type : 'log',
    position: { x: Number(node.x) || 0, y: Number(node.y) || 0 },
    data: { ...(node.data ?? {}), runMark: 'idle' },
  }));
  const edges = flow.edges.map<CanvasEdge>((edge) => {
    const when = normalizeWhen(edge.when ?? edge.data?.when);
    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      label: when === 'always' ? undefined : when,
      data: { when },
      reconnectable: true,
    };
  });
  return { nodes, edges };
}

export function toStored(flow: StoredFlow, nodes: CanvasNode[], edges: CanvasEdge[]): StoredFlow {
  return {
    ...flow,
    nodes: nodes.map((node) => {
      const { runMark: _runMark, ...data } = node.data;
      return {
        id: node.id,
        type: node.type ?? 'log',
        x: node.position.x,
        y: node.position.y,
        data,
      };
    }),
    edges: edges.map((edge) => {
      const when = normalizeWhen(edge.data?.when);
      return {
        id: edge.id,
        from: edge.source,
        to: edge.target,
        when,
        // 迁移窗口内保留旧 editor.js 可读格式，后端会原样持久化扩展字段。
        data: { when },
      };
    }),
    updatedAt: Date.now(),
  };
}

export function normalizeWhen(value: unknown): EdgeWhen {
  return value === 'true' || value === 'false' ? value : 'always';
}

export function typeMeta(type: string | undefined) {
  if (type === 'http') return NODE_CATALOG.find((item) => item.type === 'request')!;
  return NODE_CATALOG.find((item) => item.type === type) ?? {
    group: 'control' as const,
    type: 'log' as const,
    label: type || '未知节点',
    icon: '?',
  };
}

function isNodeKind(type: string): type is FlowNodeKind {
  return type === 'http' || NODE_CATALOG.some((item) => item.type === type);
}
