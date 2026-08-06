import type { Edge, Node } from '@xyflow/react';

export type FlowNodeKind =
  | 'start'
  | 'end'
  | 'condition'
  | 'loop'
  | 'parallel'
  | 'delay'
  | 'variable'
  | 'log'
  | 'extract'
  | 'request'
  /** 兼容早期未发布的实验性节点数据。新建节点统一使用 request。 */
  | 'http'
  | 'procedure'
  | 'site';

export type EdgeWhen = 'always' | 'true' | 'false';
export type RunMark = 'idle' | 'running' | 'done' | 'failed';
export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface FlowNodeData extends Record<string, unknown> {
  label?: string;
  expr?: string;
  count?: number | string;
  loopVar?: string;
  ms?: number | string;
  name?: string;
  value?: unknown;
  level?: LogLevel;
  message?: string;
  /** 技能节点必须先选网站，再从该网站技能中选择 procedureId。 */
  siteId?: string;
  procedureId?: string;
  url?: string;
  params?: Record<string, unknown>;
  /** 技能有返回值时，可将完整结果写入此变量；留空则合并命名结果。 */
  resultVariable?: string;
  selector?: string;
  mode?: 'text' | 'attribute' | 'html' | 'list' | 'table';
  attribute?: string;
  multiple?: boolean;
  variable?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | string;
  headers?: string;
  body?: string;
  timeoutMs?: number | string;
  force?: boolean;
  runMark?: RunMark;
}

export interface FlowEdgeData extends Record<string, unknown> {
  when: EdgeWhen;
}

export type CanvasNode = Node<FlowNodeData, FlowNodeKind>;
export type CanvasEdge = Edge<FlowEdgeData>;

export interface StoredFlowNode {
  id: string;
  type: FlowNodeKind | string;
  x: number;
  y: number;
  data?: FlowNodeData;
}

export interface StoredFlowEdge {
  id: string;
  from: string;
  to: string;
  when?: EdgeWhen;
  /** 兼容旧画布保存的 edge.data.when。 */
  data?: Partial<FlowEdgeData>;
}

export interface StoredFlow {
  id: string;
  name: string;
  description: string;
  nodes: StoredFlowNode[];
  edges: StoredFlowEdge[];
  variables: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ProcedureStep {
  type?: string;
  url?: string;
  selector?: string;
}

export interface Procedure {
  id: string;
  siteId?: string;
  name: string;
  kind: 'login' | 'checkin' | 'verification';
  description?: string;
  steps?: ProcedureStep[];
  output?: { enabled: boolean; fields: string[] };
}

export interface Site {
  id: string;
  name: string;
  url: string;
  checkinProcedureId?: string;
  verificationProcedureId?: string | null;
}

export interface FlowListResponse {
  ok?: boolean;
  error?: string;
  flows?: StoredFlow[];
}

export interface ProcedureListResponse {
  ok?: boolean;
  error?: string;
  procedures?: Procedure[];
}

export interface StatusResponse {
  ok?: boolean;
  error?: string;
  sites?: Site[];
}

export interface SaveFlowResponse {
  ok?: boolean;
  error?: string;
  flow?: StoredFlow;
}

export interface RunResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  queued?: number;
  status?: string;
  outputs?: Record<string, unknown>;
  returnValue?: unknown;
  tabId?: number | null;
}

/** EXTRACT_PAGE_DATA 的后台响应，保留 value/result 兼容不同执行器实现。 */
export interface ExtractPageDataResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  data?: unknown;
  value?: unknown;
  result?: unknown;
  count?: number;
  tabId?: number;
  pageUrl?: string;
}

/** HTTP_REQUEST 的后台响应。body 可能是文本，也可能是已解析 JSON。 */
export interface HttpRequestResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  status?: number;
  statusText?: string;
  headers?: unknown;
  data?: unknown;
  body?: unknown;
  result?: unknown;
}

export interface LogEntry {
  id: string;
  level: LogLevel;
  message: string;
  at: number;
}

export interface AbortState {
  aborted: boolean;
}
