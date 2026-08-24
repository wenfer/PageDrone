/** MCP 审计日志：环形缓冲，所有 MCP 工具调用都留痕，设置页可导出。 */

import { uid } from '../models.js';

const AUDIT_KEY = 'mcpAuditLog';
const MAX_AUDIT_ENTRIES = 2000;

export interface McpAuditEntry {
  id: string;
  at: number;
  tool: string;
  group: string;
  /** 参数摘要（已截断，不含敏感值原文遮盖前的完整参数） */
  summary: string;
  status: 'ok' | 'error' | 'denied';
  code?: string;
  message?: string;
  client: string;
}

function redact(value: unknown): unknown {
  const SENSITIVE = /(?:api[-_ ]?key|authorization|cookie|password|passwd|secret|token|credential|headers?)/i;
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(
    JSON.stringify(value, (key, v) => (SENSITIVE.test(key) ? '[已隐藏]' : v)),
  ) as unknown;
}

/** 写入入参：summary 允许传原始参数对象，落盘前统一脱敏 + 截断 */
export interface McpAuditInput {
  tool: string;
  group: string;
  summary?: unknown;
  status: McpAuditEntry['status'];
  code?: string;
  message?: string;
  client: string;
}

export async function appendMcpAudit(entry: McpAuditInput): Promise<void> {
  const data = await chrome.storage.local.get(AUDIT_KEY);
  const list = Array.isArray(data[AUDIT_KEY]) ? (data[AUDIT_KEY] as McpAuditEntry[]) : [];
  list.unshift({
    ...entry,
    summary: String(JSON.stringify(redact(entry.summary ?? {})) || '').slice(0, 400),
    id: uid('audit'),
    at: Date.now(),
  });
  if (list.length > MAX_AUDIT_ENTRIES) list.length = MAX_AUDIT_ENTRIES;
  await chrome.storage.local.set({ [AUDIT_KEY]: list });
}

export async function getMcpAudit(limit = 100): Promise<McpAuditEntry[]> {
  const data = await chrome.storage.local.get(AUDIT_KEY);
  const list = Array.isArray(data[AUDIT_KEY]) ? (data[AUDIT_KEY] as McpAuditEntry[]) : [];
  return list.slice(0, Math.max(1, limit));
}

export async function clearMcpAudit(): Promise<void> {
  await chrome.storage.local.set({ [AUDIT_KEY]: [] });
}
