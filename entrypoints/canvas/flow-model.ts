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
  { group: 'browser', type: 'request', label: '发送请求', icon: '↗' },
  { group: 'browser', type: 'procedure', label: '调用技能', icon: '◇' },
  { group: 'browser', type: 'site', label: '执行站点', icon: '◎' },
];

export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

// 流程默认骨架由 src/lib/flows.ts#createFlow 统一生成；本模块只负责画布模型转换。
export function uid(prefix: 'flow' | 'n' | 'e'): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;
}

export function defaultNodeData(type: FlowNodeKind): FlowNodeData {
  const policy = { nodeTimeoutMs: 120000, retryCount: 0, retryDelayMs: 1000, continueOnError: true };
  switch (type) {
    case 'condition': return { ...policy, expr: 'true' };
    case 'loop': return { ...policy, count: 3, loopVar: 'i' };
    case 'delay': return { ...policy, ms: 1000 };
    case 'variable': return { ...policy, name: 'var1', value: '' };
    case 'log': return { level: 'info', message: '' };
    case 'request':
    case 'http': return {
      ...policy, url: '', method: 'GET', headers: '', body: '', timeoutMs: 30000, variable: 'response',
    };
    case 'procedure': return { ...policy, siteId: '', procedureId: '', url: '', params: {} };
    case 'site': return { ...policy, siteId: '', force: false };
    default: return {};
  }
}

export function toCanvas(flow: StoredFlow): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes = flow.nodes.map<CanvasNode>((node) => {
    const legacyExtract = node.type === 'extract';
    return {
      id: node.id,
      // 提取数据已经收口为网站技能内的原子操作。旧流程节点保留原连线，
      // 但转换为明确的迁移提示，避免继续表现成可执行的流程能力。
      type: legacyExtract ? 'log' : node.type === 'http' ? 'request' : isNodeKind(node.type) ? node.type : 'log',
      position: { x: Number(node.x) || 0, y: Number(node.y) || 0 },
      data: legacyExtract
        ? {
            label: '需要迁移：提取数据',
            level: 'warn',
            message: '请把提取操作放入网站技能，并通过“调用技能”的返回值传给后续节点。',
            runMark: 'idle',
          }
        : { ...(node.data ?? {}), runMark: 'idle' },
    };
  });
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
