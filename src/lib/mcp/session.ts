/**
 * MCP 会话层：出站 WebSocket 连接桥接进程（方案 A）。
 * 心跳 ≤25s 重置 MV3 SW 空闲计时器；chrome.alarms 兜底自检重连；
 * 断线指数退避（1s→2s→…→60s 上限）；会话状态全量持久化 chrome.storage.local。
 */

import {
  assertBridgeHostAllowed,
  getMcpConfig,
  setMcpSessionState,
} from './config.js';
import {
  JSON_RPC_ERRORS,
  MCP_TOOLS,
  jsonRpcError,
  jsonRpcResult,
  toolCallResult,
  type JsonRpcRequest,
} from './protocol.js';
import { mapErrorToMcp } from './errors.js';
import { handleMcpToolCall } from './tools.js';
import { setExecutionProgressHook } from './executions.js';

export const MCP_KEEPALIVE_ALARM = 'mcp-keepalive';

/** 心跳间隔 20s，低于 MV3 约 30s 的 SW 空闲阈值（Chrome ≥116 活跃 WS 可保活） */
const HEARTBEAT_MS = 20_000;
/** 单桥接会话并发在途工具调用上限 */
const MAX_INFLIGHT_CALLS = 4;
const RECONNECT_MAX_DELAY_MS = 60_000;

let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let intentionallyClosed = false;
let inflightCalls = 0;
let clientLabel = '';

function isSocketLive(): boolean {
  return !!ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN);
}

function rawSend(payload: string): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(payload);
    return true;
  } catch {
    return false;
  }
}

/** 向桥接进程推送 MCP notification（如 notifications/progress） */
export function sendMcpNotification(method: string, params: Record<string, unknown>): void {
  rawSend(JSON.stringify({ jsonrpc: '2.0', method, params }));
}

function pushExecutionProgress(executionId: string, record: { progress?: Array<{ at: number; message: string }>; state: string }): void {
  const latest = record.progress?.[record.progress.length - 1];
  sendMcpNotification('notifications/progress', {
    progressToken: executionId,
    progress: record.progress?.length ?? 0,
    message: latest?.message ?? record.state,
    executionId,
    state: record.state,
  });
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    rawSend(JSON.stringify({ type: 'ping', at: Date.now() }));
  }, HEARTBEAT_MS);
}

function scheduleReconnect(): void {
  if (reconnectTimer || intentionallyClosed) return;
  const delay = Math.min(RECONNECT_MAX_DELAY_MS, 1000 * 2 ** Math.min(reconnectAttempts, 6));
  reconnectAttempts += 1;
  void setMcpSessionState({ reconnectAttempts });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectMcp();
  }, delay);
}

async function teardownSocket(reason: string): Promise<void> {
  stopHeartbeat();
  const socket = ws;
  ws = null;
  if (socket) {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      /* already closing */
    }
  }
  await setMcpSessionState({
    connected: false,
    lastDisconnectedAt: Date.now(),
    lastError: reason,
  });
  if (!intentionallyClosed) scheduleReconnect();
}

/** 建立到桥接进程的出站 WebSocket 连接（令牌拼在路径上完成配对握手） */
export async function connectMcp(): Promise<void> {
  intentionallyClosed = false;
  const cfg = await getMcpConfig();
  if (!cfg.enabled) return;
  if (isSocketLive()) return;
  let wsUrl: string;
  try {
    const parsed = assertBridgeHostAllowed(cfg.bridgeUrl, cfg.allowedBridgeHosts);
    if (!cfg.token) throw new Error('缺少配对令牌，请在设置页开启 MCP 服务以自动生成');
    const base = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
    wsUrl = `${base}/${encodeURIComponent(cfg.token)}${parsed.search}`;
  } catch (e) {
    await setMcpSessionState({ connected: false, lastError: (e as Error).message });
    scheduleReconnect();
    return;
  }

  let socket: WebSocket;
  try {
    socket = new WebSocket(wsUrl);
  } catch (e) {
    await setMcpSessionState({ connected: false, lastError: `无法建立连接：${(e as Error).message}` });
    scheduleReconnect();
    return;
  }
  ws = socket;
  socket.onopen = () => {
    reconnectAttempts = 0;
    clientLabel = clientLabel || 'bridge';
    void setMcpSessionState({
      connected: true,
      clientLabel,
      lastConnectedAt: Date.now(),
      reconnectAttempts: 0,
      lastError: '',
    });
    startHeartbeat();
  };
  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;
    void handleBridgeFrame(event.data);
  };
  socket.onerror = () => {
    /* onclose 随后触发，统一在 onclose 里收尾 */
  };
  socket.onclose = (event: CloseEvent) => {
    if (ws !== socket) return;
    const reason = event.reason || `连接关闭（${event.code}）`;
    void teardownSocket(reason);
  };
}

/** 用户/配置触发的主动断开：不进入自动重连 */
export async function disconnectMcp(reason = '用户断开'): Promise<void> {
  intentionallyClosed = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  await teardownSocket(reason);
}

async function handleBridgeFrame(raw: string): Promise<void> {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }
  if (!frame || typeof frame !== 'object') return;
  const msg = frame as Record<string, unknown>;

  // 桥接进程控制帧
  if (msg.type === 'ping') {
    rawSend(JSON.stringify({ type: 'pong', at: Date.now() }));
    return;
  }
  if (msg.type === 'hello_ack' || msg.type === 'pong') {
    if (typeof msg.client === 'string' && msg.client) {
      clientLabel = msg.client;
      void setMcpSessionState({ clientLabel });
    }
    return;
  }

  // JSON-RPC 请求（来自 stdio 端的 MCP 客户端，经桥接转发）
  if (msg.jsonrpc === '2.0' && typeof msg.method === 'string') {
    await dispatchBridgeRequest(msg as unknown as JsonRpcRequest);
  }
}

async function dispatchBridgeRequest(request: JsonRpcRequest): Promise<void> {
  const id = request.id ?? null;
  // 通知帧没有 id：initialized 等 lifecycle 通知直接忽略
  if (request.id === undefined) return;

  if (inflightCalls >= MAX_INFLIGHT_CALLS) {
    rawSend(jsonRpcError(id, JSON_RPC_ERRORS.INTERNAL, `并发工具调用已达上限（${MAX_INFLIGHT_CALLS}），请稍后重试`));
    return;
  }
  inflightCalls += 1;
  try {
    switch (request.method) {
      case 'initialize': {
        rawSend(
          jsonRpcResult(id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'pagedrone', version: chrome.runtime.getManifest().version },
          }),
        );
        return;
      }
      case 'notifications/initialized':
        return;
      case 'ping': {
        rawSend(jsonRpcResult(id, {}));
        return;
      }
      case 'tools/list': {
        rawSend(
          jsonRpcResult(id, {
            tools: MCP_TOOLS.map((tool) => ({
              name: tool.name,
              description: `[${tool.group}] ${tool.description}`,
              inputSchema: tool.inputSchema,
              annotations: { readOnlyHint: tool.group === 'read' },
            })),
          }),
        );
        return;
      }
      case 'tools/call': {
        const params = (request.params || {}) as { name?: unknown; arguments?: Record<string, unknown> };
        const name = String(params.name || '');
        const args = params.arguments || {};
        try {
          const data = await handleMcpToolCall(name, args, clientLabel || 'bridge');
          rawSend(jsonRpcResult(id, toolCallResult(data)));
        } catch (e) {
          const mapped = mapErrorToMcp(e);
          rawSend(jsonRpcResult(id, toolCallResult({ code: mapped.code, message: mapped.message, retryable: mapped.retryable }, true)));
        }
        return;
      }
      default:
        rawSend(jsonRpcError(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `未知方法 ${request.method}`));
    }
  } finally {
    inflightCalls -= 1;
  }
}

// —— alarms 兜底保活 ——

export async function ensureMcpAlarm(enabled: boolean): Promise<void> {
  const existing = await chrome.alarms.get(MCP_KEEPALIVE_ALARM);
  if (enabled && !existing) {
    await chrome.alarms.create(MCP_KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  } else if (!enabled && existing) {
    await chrome.alarms.clear(MCP_KEEPALIVE_ALARM);
  }
}

/** SW 启动 / 安装时调用：恢复告警与连接 */
export async function initMcp(): Promise<void> {
  setExecutionProgressHook((record) => pushExecutionProgress(record.id, record));
  const cfg = await getMcpConfig();
  await ensureMcpAlarm(cfg.enabled);
  if (cfg.enabled) void connectMcp();
  else if (!isSocketLive()) await setMcpSessionState({ connected: false });
}

/** keepalive 周期闹钟：自检连接状态并重连 */
export async function mcpKeepalive(): Promise<void> {
  const cfg = await getMcpConfig();
  if (!cfg.enabled) {
    await ensureMcpAlarm(false);
    return;
  }
  await ensureMcpAlarm(true);
  if (!isSocketLive()) void connectMcp();
  else rawSend(JSON.stringify({ type: 'ping', at: Date.now() }));
}

/** 设置页「立即重连」入口 */
export async function reconnectMcp(): Promise<void> {
  await disconnectMcp('重新连接');
  intentionallyClosed = false;
  reconnectAttempts = 0;
  await connectMcp();
}
