/**
 * MCP 错误码规范：统一封装 { code, message, retryable }。
 * 映射自现有错误类（errors.ts）与执行链路的中文文案特征。
 */

import { AbortedError, DeadlineError, TabGoneError, LoginRedirectError } from '../errors.js';

export type McpErrorCode =
  | 'AUTH_FAILED'
  | 'TOOL_DISABLED_BY_MODE'
  | 'DOMAIN_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'EXECUTION_TIMEOUT'
  | 'TAB_GONE'
  | 'LOGIN_REQUIRED'
  | 'CF_CHALLENGE'
  | 'NEED_MANUAL'
  | 'ABORTED'
  | 'CONFIRM_DENIED'
  | 'BRIDGE_DISCONNECTED'
  | 'INTERNAL';

export class McpToolError extends Error {
  constructor(
    readonly code: McpErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

export interface MappedMcpError {
  code: McpErrorCode;
  message: string;
  retryable: boolean;
}

/** 把任意异常映射为 MCP 错误码；未分类的落 INTERNAL */
export function mapErrorToMcp(e: unknown): MappedMcpError {
  if (e instanceof McpToolError) return { code: e.code, message: e.message, retryable: e.retryable };
  if (e instanceof TabGoneError) return { code: 'TAB_GONE', message: e.message, retryable: false };
  if (e instanceof AbortedError) return { code: 'ABORTED', message: e.message, retryable: false };
  if (e instanceof DeadlineError) return { code: 'EXECUTION_TIMEOUT', message: e.message, retryable: true };
  if (e instanceof LoginRedirectError) return { code: 'LOGIN_REQUIRED', message: e.message, retryable: true };
  const raw = (e as Error)?.message || String(e);
  if (/防护|Cloudflare|人机验证/i.test(raw)) return { code: 'CF_CHALLENGE', message: raw, retryable: true };
  if (/需登录|登录(已)?(失效|过期)|请登录|login required|need[_ ]?login/i.test(raw)) {
    return { code: 'LOGIN_REQUIRED', message: raw, retryable: true };
  }
  if (/不存在|找不到|没有找到/i.test(raw)) return { code: 'NOT_FOUND', message: raw, retryable: false };
  if (/超时/i.test(raw)) return { code: 'EXECUTION_TIMEOUT', message: raw, retryable: true };
  return { code: 'INTERNAL', message: raw, retryable: false };
}
