import type { SkillTrace } from '../../../../src/lib/types.js';

const SENSITIVE_KEY = /(?:api[-_ ]?key|authorization|cookie|password|passwd|secret|token|credential)/i;
const TOKEN_VALUE = /\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{28,})\b/g;

function redactString(value: string): string {
  return value.replace(TOKEN_VALUE, (match) => match.startsWith('Bearer ') ? 'Bearer [已隐藏]' : '[已隐藏]');
}

export function redactValue(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY.test(key)) return '[已隐藏]';
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[循环引用]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, '', seen));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
      entryKey,
      redactValue(entryValue, entryKey, seen),
    ]),
  );
}

export function renderTraceArgs(trace: SkillTrace): string {
  try {
    return JSON.stringify(redactValue(trace.args), null, 2);
  } catch {
    return '（参数无法序列化）';
  }
}

export function formatConversationTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function formatMessageTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

export function formatMessageDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return '今天';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function sameCalendarDay(left: number, right: number): boolean {
  return new Date(left).toDateString() === new Date(right).toDateString();
}
