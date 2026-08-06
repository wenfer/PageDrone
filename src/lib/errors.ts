/**
 * 控制流错误类。
 * 这几类错误一旦发生就没有继续跑的意义，必须原样上抛，不能被重试逻辑吞掉。
 * 用类而不是匹配中文错误文案，是因为文案会改、会被拼接、会被翻译。
 */

/** 用户点了停止 / 强制重置 */
export class AbortedError extends Error {
  constructor(message = '已取消执行') {
    super(message);
    this.name = 'AbortedError';
  }
}

/** 目标标签页已不存在 */
export class TabGoneError extends Error {
  constructor(message = '标签页已关闭（请勿中途关掉目标页）') {
    super(message);
    this.name = 'TabGoneError';
  }
}

/** 单站硬性时间上限到了：整站已经跑太久，剩下的步骤没有意义 */
export class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineError';
  }
}

/** 目标页返回了 5xx/404 等网关错误 */
export class HttpError extends Error {
  status: number;
  constructor(status: number, title: string) {
    super(`页面返回错误 ${status}（${title || '无标题'}）。请检查网址是否可访问，或稍后再试`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** 执行中途掉到登录页，用于触发自动重登 */
export class LoginRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginRedirectError';
  }
}

/** 致命错误：不该重试、不该吞掉，遇到必须原样上抛 */
export function isFatal(e: unknown): boolean {
  return e instanceof AbortedError || e instanceof TabGoneError || e instanceof DeadlineError;
}
