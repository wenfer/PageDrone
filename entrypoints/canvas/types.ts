import type { Edge, Node } from '@xyflow/react';
import type { FlowEdgeWhen } from '../../src/lib/models.js';
import type { FlowNodeReport, FlowTestReport, PageObservation } from '../../src/lib/types.js';
export type { FlowErrorType, FlowNodeReport, FlowTestReport } from '../../src/lib/types.js';

export type FlowNodeKind =
  | 'start'
  | 'end'
  | 'condition'
  | 'loop'
  | 'parallel'
  | 'delay'
  | 'variable'
  | 'log'
  | 'request'
  /** 兼容早期未发布的实验性节点数据。新建节点统一使用 request。 */
  | 'http'
  | 'procedure'
  | 'site';

/** 与持久化 Flow 模型共用边条件，避免画布和后台出现分叉定义。 */
export type EdgeWhen = FlowEdgeWhen;
export type RunMark = 'idle' | 'running' | 'done' | 'failed' | 'timeout' | 'need_login' | 'skipped' | 'aborted';
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
  variable?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | string;
  headers?: string;
  body?: string;
  timeoutMs?: number | string;
  /** 节点自身的总超时，不影响请求或技能内部步骤超时。 */
  nodeTimeoutMs?: number | string;
  retryCount?: number | string;
  retryDelayMs?: number | string;
  /** 默认 true：失败后继续执行后续节点。 */
  continueOnError?: boolean;
  lastReport?: FlowNodeReport;
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
  siteSync?: {
    mode: 'manual' | 'all-sites';
    includeDisabled: boolean;
    includeMissingSiteId: boolean;
    includeLoginProcedures: boolean;
    autoSync: boolean;
  };
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
  enabled: boolean;
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
  observations?: PageObservation[];
  failedStepIndex?: number;
  failedStepType?: string;
  executionId?: string;
}

export type CanvasFlowTestReport = FlowTestReport;

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
