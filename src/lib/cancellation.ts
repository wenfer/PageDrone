/**
 * 取消令牌：替代 runner 里散落的模块级 abortRequested / siteDeadline。
 * 每次执行（一个站点 / 一次独立技能运行）持有一个独立令牌，
 * stopQueue 调 abort()，站点硬超时由 deadline 控制。
 */

import { AbortedError, DeadlineError } from './errors.js';

export class CancellationToken {
  aborted = false;
  /** 硬截止时间戳（ms），0 表示无截止 */
  deadline = 0;
  private waiters: Array<() => void> = [];

  abort(): void {
    this.aborted = true;
    for (const w of this.waiters) w();
    this.waiters = [];
  }

  setDeadline(timeoutMs: number): void {
    this.deadline = Date.now() + Math.max(0, timeoutMs);
  }

  clearDeadline(): void {
    this.deadline = 0;
  }

  /** 中止或超时则抛错；否则继续 */
  check(): void {
    if (this.aborted) throw new AbortedError();
    if (this.deadline && Date.now() > this.deadline) {
      throw new DeadlineError('单站执行总超时，已中止（可点「强制停止」后重试）');
    }
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  /**
   * 可中断的分块 sleep：每 250ms 检查一次中止/超时。
   * 标签存活检查由调用方（TabSession/RunContext）在需要时另行轮询。
   */
  async sleep(ms: number): Promise<void> {
    const end = Date.now() + Math.max(0, ms);
    while (Date.now() < end) {
      this.check();
      const chunk = Math.min(250, end - Date.now());
      if (chunk <= 0) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          // 正常计时触发：把自己的中止回调摘掉，避免在 waiters 里累积闭包
          const idx = this.waiters.indexOf(onAbort);
          if (idx >= 0) this.waiters.splice(idx, 1);
          resolve();
        }, chunk);
        const onAbort = () => {
          clearTimeout(timer);
          const idx = this.waiters.indexOf(onAbort);
          if (idx >= 0) this.waiters.splice(idx, 1);
          resolve();
        };
        this.waiters.push(onAbort);
      });
      this.check();
    }
  }
}
