/**
 * MCP 用户确认（write 组工具 / browser 组新域名）。
 * 确认请求镜像到 chrome.storage.local，UI 轮询展示；SW 重启后在途确认作废。
 */

const PENDING_KEY = 'mcpPendingConfirms';
const CONFIRM_TTL_MS = 120_000;

export interface McpPendingConfirm {
  id: string;
  kind: 'write' | 'domain';
  /** write：工具名；domain：目标域名 */
  target: string;
  summary: string;
  createdAt: number;
  expiresAt: number;
}

interface ConfirmSlot {
  confirm: McpPendingConfirm;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

// 会话级记忆：“本会话内记住”的 write 工具与已放行域名
const rememberedWrites = new Set<string>();
const rememberedDomains = new Set<string>();

const slots = new Map<string, ConfirmSlot>();

async function persistPending(): Promise<void> {
  const list = [...slots.values()].map((slot) => slot.confirm);
  await chrome.storage.local.set({ [PENDING_KEY]: list });
}

export function rememberWrite(tool: string): void {
  rememberedWrites.add(tool);
}

export function rememberDomain(domain: string): void {
  rememberedDomains.add(domain);
}

export function isWriteRemembered(tool: string): boolean {
  return rememberedWrites.has(tool);
}

export function isDomainRemembered(domain: string): boolean {
  return rememberedDomains.has(domain);
}

export function listPendingConfirms(): McpPendingConfirm[] {
  return [...slots.values()].map((slot) => slot.confirm).sort((a, b) => a.createdAt - b.createdAt);
}

export async function requestMcpConfirm(confirm: Omit<McpPendingConfirm, 'id' | 'createdAt' | 'expiresAt'>): Promise<boolean> {
  const id = `confirm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const record: McpPendingConfirm = {
    ...confirm,
    id,
    createdAt: Date.now(),
    expiresAt: Date.now() + CONFIRM_TTL_MS,
  };
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      slots.delete(id);
      void persistPending();
      resolve(false);
    }, CONFIRM_TTL_MS);
    slots.set(id, { confirm: record, resolve, timer });
    void persistPending();
  });
}

/** UI 决策入口；返回 false 表示确认不存在或已过期 */
export async function resolveMcpConfirm(id: string, approved: boolean, remember: boolean): Promise<boolean> {
  const slot = slots.get(id);
  if (slot) {
    clearTimeout(slot.timer);
    slots.delete(id);
    if (remember) {
      if (slot.confirm.kind === 'write') rememberedWrites.add(slot.confirm.target);
      else rememberedDomains.add(slot.confirm.target);
    }
    slot.resolve(approved);
    await persistPending();
    return true;
  }
  // SW 重启后内存槽位丢失：清理存储镜像，让 UI 不再显示幽灵确认
  const data = await chrome.storage.local.get(PENDING_KEY);
  const stored = Array.isArray(data[PENDING_KEY]) ? (data[PENDING_KEY] as McpPendingConfirm[]) : [];
  if (stored.some((item) => item.id === id)) {
    await chrome.storage.local.set({
      [PENDING_KEY]: stored.filter((item) => item.id !== id),
    });
  }
  return false;
}
