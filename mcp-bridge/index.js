#!/usr/bin/env node
/**
 * pagedrone-mcp —— PageDrone（Chrome MV3 扩展）的本地 MCP 桥接进程。
 *
 * 架构（方案 A）：
 *   MCP 客户端(stdio) ⇄ 本进程 ⇄ WebSocket(ws://127.0.0.1:<port>/<token>) ⇄ 扩展 Service Worker
 *
 * 用法：
 *   npx pagedrone-mcp [--port 9377] [--token <配对令牌>]
 *   环境变量：PAGEDRONE_BRIDGE_PORT / PAGEDRONE_TOKEN
 *
 * 令牌必须与扩展设置页「MCP 服务」中显示的配对令牌一致；不传则随机生成并打印。
 */

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const readline = require('readline');
const { version: BRIDGE_VERSION } = require('./package.json');

const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_PORT = 9377;
/** 桥接与扩展断连时，客户端请求排队等待的 TTL（毫秒） */
const QUEUE_TTL_MS = 60_000;
/** 转发到扩展的工具调用超时（毫秒） */
const FORWARD_TIMEOUT_MS = 300_000;
/** 心跳判定：超过该时长没有任何扩展消息则认为连接已死 */
const EXTENSION_IDLE_MS = 90_000;

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, token: process.env.PAGEDRONE_TOKEN || '' };
  if (process.env.PAGEDRONE_BRIDGE_PORT) args.port = Number(process.env.PAGEDRONE_BRIDGE_PORT) || DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if ((item === '--port' || item === '-p') && argv[i + 1]) args.port = Number(argv[++i]) || DEFAULT_PORT;
    if ((item === '--token' || item === '-t') && argv[i + 1]) args.token = String(argv[++i]);
    if (item === '--help' || item === '-h') args.help = true;
  }
  return args;
}

function log(...parts) {
  // 结构化日志走 stderr，stdout 只允许 JSON-RPC 帧
  process.stderr.write(`[pagedrone-mcp ${new Date().toISOString()}] ${parts.join(' ')}\n`);
}

class Bridge {
  constructor(options) {
    this.port = options.port;
    this.token = options.token || crypto.randomBytes(24).toString('hex');
    /** 当前活跃的扩展 WS 连接（同一令牌重复连接时采用最新） */
    this.extension = null;
    /** stdio 侧请求 → { resolve, reject, timer }，按桥接内部 id 索引 */
    this.pendingToExtension = new Map();
    /** 断连期间排队的待转发调用 */
    this.queuedCalls = [];
    this.extSeq = 0;
    this.lastExtensionMessageAt = 0;
  }

  start() {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });
    this.wss.on('connection', (socket, request) => this.onExtensionConnection(socket, request));
    this.wss.on('error', (err) => log('WS server error:', err.message));

    this.rl = readline.createInterface({ input: process.stdin, terminal: false });
    this.rl.on('line', (line) => this.onStdioLine(line));
    this.rl.on('close', () => this.shutdown());

    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());

    log(`桥接进程已启动，监听 ws://127.0.0.1:${this.port}`);
    log(`配对令牌：${this.token}`);
    log('请在扩展设置页「MCP 服务」开启开关，并将桥接地址配置为');
    log(`  ws://127.0.0.1:${this.port}   配对令牌：${this.token}`);
    if (!process.env.PAGEDRONE_TOKEN) {
      log('提示：可用 --token 或环境变量 PAGEDRONE_TOKEN 固定令牌，便于 MCP 客户端配置复用。');
    }
  }

  shutdown() {
    log('正在退出…');
    for (const [, slot] of this.pendingToExtension) {
      clearTimeout(slot.timer);
      slot.reject(new Error('桥接进程已退出'));
    }
    this.pendingToExtension.clear();
    if (this.extension) {
      try { this.extension.close(); } catch { /* ignore */ }
    }
    try { this.wss && this.wss.close(); } catch { /* ignore */ }
    process.exit(0);
  }

  // —— 扩展侧（WebSocket） ——

  onExtensionConnection(socket, request) {
    const tokenInUrl = decodeURIComponent((request.url || '').replace(/^\/+/, '').split('?')[0]);
    if (!tokenInUrl || tokenInUrl !== this.token) {
      log('拒绝一次握手：配对令牌不匹配');
      socket.close(4001, 'AUTH_FAILED');
      return;
    }
    if (this.extension) {
      try { this.extension.close(); } catch { /* ignore */ }
    }
    this.extension = socket;
    this.lastExtensionMessageAt = Date.now();
    log('扩展已连接');

    socket.send(JSON.stringify({ type: 'hello_ack', client: `pagedrone-mcp@${BRIDGE_VERSION}` }));
    // 重连后重放断连期间排队的调用（带 TTL）
    const queued = this.queuedCalls.splice(0);
    for (const call of queued) {
      if (Date.now() - call.queuedAt > QUEUE_TTL_MS) {
        call.reject(new Error(`BRIDGE_DISCONNECTED：扩展断连期间排队超时（${QUEUE_TTL_MS}ms）`));
      } else {
        this.forwardToExtension(call.frame).then(call.resolve, call.reject);
      }
    }

    socket.on('message', (data) => this.onExtensionMessage(String(data)));
    socket.on('close', () => {
      if (this.extension === socket) {
        this.extension = null;
        log('扩展已断开，等待重连（客户端请求将短暂排队）');
      }
    });
    socket.on('error', () => { /* close 会随后触发 */ });

    // 死链检测：长时间无任何消息则主动断开，让扩展的重连逻辑接管
    clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      if (this.extension !== socket) return clearInterval(this.idleTimer);
      if (Date.now() - this.lastExtensionMessageAt > EXTENSION_IDLE_MS) {
        log('扩展连接空闲超时，主动断开等待重连');
        try { socket.terminate(); } catch { /* ignore */ }
      }
    }, 30_000);
  }

  onExtensionMessage(raw) {
    this.lastExtensionMessageAt = Date.now();
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;

    // 控制帧：心跳
    if (frame.type === 'ping') {
      this.extensionSend(JSON.stringify({ type: 'pong', at: Date.now() })).catch(() => undefined);
      return;
    }
    if (frame.type === 'pong' || frame.type === 'hello_ack') return;

    // JSON-RPC 响应（对应我们转发出去的 tools/list、tools/call）
    if (frame.jsonrpc === '2.0' && frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      const key = `ext:${frame.id}`;
      const slot = this.pendingToExtension.get(key);
      if (slot) {
        clearTimeout(slot.timer);
        this.pendingToExtension.delete(key);
        slot.resolve(frame);
      }
      return;
    }

    // JSON-RPC 通知（如 notifications/progress）：透传给 stdio 客户端
    if (frame.jsonrpc === '2.0' && typeof frame.method === 'string' && frame.id === undefined) {
      this.writeStdio(frame);
    }
  }

  extensionSend(payload) {
    if (!this.extension || this.extension.readyState !== 1) {
      return Promise.reject(new Error('BRIDGE_DISCONNECTED：扩展未连接'));
    }
    return new Promise((resolve, reject) => {
      this.extension.send(payload, (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * 把一个 JSON-RPC 请求帧转发给扩展并等待响应。
   * 扩展未在线且 frame 是 tools/call 时进入排队（TTL 内重连后重放）。
   */
  forwardToExtension(frame, { queueIfOffline = true } = {}) {
    if (!this.extension || this.extension.readyState !== 1) {
      if (queueIfOffline && frame.method === 'tools/call') {
        return new Promise((resolve, reject) => {
          this.queuedCalls.push({ frame, resolve, reject, queuedAt: Date.now() });
        });
      }
      return Promise.reject(new Error('BRIDGE_DISCONNECTED：扩展未连接，请确认已在设置页开启 MCP 服务'));
    }
    const extId = ++this.extSeq;
    const wire = { jsonrpc: '2.0', id: extId, method: frame.method };
    if (frame.params !== undefined) wire.params = frame.params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingToExtension.delete(`ext:${extId}`);
        reject(new Error(`EXECUTION_TIMEOUT：扩展在 ${FORWARD_TIMEOUT_MS}ms 内未响应 ${frame.method}`));
      }, FORWARD_TIMEOUT_MS);
      this.pendingToExtension.set(`ext:${extId}`, { resolve, reject, timer });
      this.extensionSend(JSON.stringify(wire)).catch((err) => {
        clearTimeout(timer);
        this.pendingToExtension.delete(`ext:${extId}`);
        reject(err);
      });
    });
  }

  // —— stdio 侧（MCP 客户端） ——

  onStdioLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      this.writeStdio({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    void this.handleClientFrame(frame);
  }

  async handleClientFrame(frame) {
    const { id, method, params } = frame;
    const isNotification = id === undefined;

    switch (method) {
      case 'initialize':
        this.writeStdio({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'pagedrone', version: BRIDGE_VERSION },
          },
        });
        return;
      case 'notifications/initialized':
        return;
      case 'ping':
        if (!isNotification) this.writeStdio({ jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list':
      case 'tools/call': {
        try {
          const response = await this.forwardToExtension(
            { method, params },
            // initialize 之前的 tools/list 也应工作：离线时直接报错而非挂起
            { queueIfOffline: method === 'tools/call' },
          );
          if (response.error) {
            if (!isNotification) {
              this.writeStdio({ jsonrpc: '2.0', id, error: response.error });
            }
            return;
          }
          if (!isNotification) this.writeStdio({ jsonrpc: '2.0', id, result: response.result ?? {} });
        } catch (err) {
          if (!isNotification) {
            this.writeStdio({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: err.message }],
                isError: true,
              },
            });
          }
        }
        return;
      }
      default:
        if (!isNotification) {
          this.writeStdio({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          });
        }
    }
  }

  writeStdio(frame) {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`pagedrone-mcp v${BRIDGE_VERSION}\n\n用法：npx pagedrone-mcp [--port 9377] [--token <配对令牌>]\n环境变量：PAGEDRONE_BRIDGE_PORT / PAGEDRONE_TOKEN\n\n先在 PageDrone 扩展设置页打开「MCP 服务」总开关获取配对令牌，再以相同令牌启动本进程。\n`);
  process.exit(0);
}
new Bridge(options).start();
