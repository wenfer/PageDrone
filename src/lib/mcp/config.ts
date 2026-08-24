/**
 * MCP 服务配置与会话状态（chrome.storage.local 持久化，SW 冷启动毫秒级重建）。
 * 安全铁律：总开关默认关闭；令牌仅存本地；桥接地址默认只允许本机回环。
 */

const CONFIG_KEY = 'mcpConfig';
const STATE_KEY = 'mcpSessionState';

export type McpAuthMode = 'readonly' | 'standard' | 'full';

export interface McpConfig {
  /** 总开关：默认关闭。关闭即断开 WS 并拒绝一切 MCP 调用。 */
  enabled: boolean;
  /** 出站 WebSocket 桥接地址，如 ws://127.0.0.1:9377 */
  bridgeUrl: string;
  /** 配对令牌：桥接握手必须携带；仅存本地，UI 可一键轮换 */
  token: string;
  /** 授权模式：readonly 只读 / standard 标准（write 需确认）/ full 完全（write 免确认） */
  mode: McpAuthMode;
  /** 额外允许 browser 组操作的域名（不属于任何已配置站点时） */
  allowedDomains: string[];
  /** 硬拒绝 browser 组操作的域名黑名单 */
  blockedDomains: string[];
  /** 回环之外的桥接主机名白名单（需用户逐条添加） */
  allowedBridgeHosts: string[];
}

export interface McpSessionState {
  connected: boolean;
  clientLabel: string;
  lastConnectedAt: number;
  lastDisconnectedAt: number;
  reconnectAttempts: number;
  lastError: string;
}

export const DEFAULT_MCP_BRIDGE_URL = 'ws://127.0.0.1:9377';

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function defaultMcpConfig(): McpConfig {
  return {
    enabled: false,
    bridgeUrl: DEFAULT_MCP_BRIDGE_URL,
    token: '',
    mode: 'readonly',
    allowedDomains: [],
    blockedDomains: [],
    allowedBridgeHosts: [],
  };
}

export async function getMcpConfig(): Promise<McpConfig> {
  const data = await chrome.storage.local.get(CONFIG_KEY);
  return { ...defaultMcpConfig(), ...((data[CONFIG_KEY] as Partial<McpConfig>) || {}) };
}

/** 解析并校验桥接地址；回环主机直接放行，其余必须在 allowedBridgeHosts 中 */
export function assertBridgeHostAllowed(url: string, allowedBridgeHosts: string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`桥接地址无效：${url}`);
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('桥接地址必须是 ws:// 或 wss:// 开头');
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!loopback && !allowedBridgeHosts.map((h) => h.toLowerCase()).includes(host)) {
    throw new Error(
      `桥接主机 "${host}" 不在允许列表中。出于安全考虑，默认仅允许本机回环地址（127.0.0.1 / localhost），其他主机请在设置页逐条添加并确认`,
    );
  }
  return parsed;
}

/**
 * 更新 MCP 配置。开启开关但尚无令牌时自动生成；返回更新后的完整配置。
 */
export async function updateMcpConfig(
  patch: Partial<Omit<McpConfig, 'token'>> & { rotateToken?: boolean } = {},
): Promise<McpConfig> {
  const current = await getMcpConfig();
  const next: McpConfig = { ...current };
  for (const key of ['enabled', 'mode'] as const) {
    if (patch[key] !== undefined) next[key] = patch[key] as never;
  }
  if (patch.bridgeUrl !== undefined) next.bridgeUrl = String(patch.bridgeUrl).trim();
  if (patch.allowedDomains !== undefined) next.allowedDomains = normalizeDomainList(patch.allowedDomains);
  if (patch.blockedDomains !== undefined) next.blockedDomains = normalizeDomainList(patch.blockedDomains);
  if (patch.allowedBridgeHosts !== undefined) next.allowedBridgeHosts = normalizeDomainList(patch.allowedBridgeHosts);
  if (patch.rotateToken || (next.enabled && !next.token)) next.token = randomToken();
  await chrome.storage.local.set({ [CONFIG_KEY]: next });
  return next;
}

export async function getMcpSessionState(): Promise<McpSessionState> {
  const data = await chrome.storage.local.get(STATE_KEY);
  return (
    (data[STATE_KEY] as McpSessionState) || {
      connected: false,
      clientLabel: '',
      lastConnectedAt: 0,
      lastDisconnectedAt: 0,
      reconnectAttempts: 0,
      lastError: '',
    }
  );
}

export async function setMcpSessionState(patch: Partial<McpSessionState>): Promise<McpSessionState> {
  const next = { ...(await getMcpSessionState()), ...patch };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

function normalizeDomainList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
}
