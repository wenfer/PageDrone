/**
 * ExecutionQueue：站点执行的串行队列。
 * 封装原 runner.js 里的 queue[]/queueRunning/drainToken/currentTaskId 等模块级状态，
 * 每个站点构造一个 RunContext 执行，结果写站点 lastResult 与日志。
 */

import {
  getSettings,
  getSite,
  getProcedure,
  updateSiteLastResult,
  appendLog,
  startTask,
  upsertTask,
  setRuntime,
} from './storage.js';
import { RUN_STATE } from './messaging.js';
import { CancellationToken } from './cancellation.js';
import { RunContext, type RunTarget } from './run-context.js';
import { setQueueRunningHook, abortPendingIntervention } from './run-context.js';
import { updateBadgeFromLogs, notifySummary } from './scheduler.js';
import { isFatal } from './errors.js';
import type {
  Site,
  CheckinProcedure,
  LoginProcedure,
  VerificationProcedure,
  Settings,
  TaskTrigger,
  Log,
  RunStatus,
  Step,
} from './models.js';
import type { RunOutcome } from './types.js';

interface QueueItem {
  siteId: string;
  reason: string;
}

interface LegacySite {
  steps?: Step[];
  script?: string;
  successKeywords?: string[];
  failKeywords?: string[];
  login?: {
    enabled?: boolean;
    steps?: Step[];
    timeoutMs?: number;
    loggedInSelector?: string;
    loggedInUrlIncludes?: string;
  };
}

export class ExecutionQueue {
  private queue: QueueItem[] = [];
  private running = false;
  private drainToken = 0;
  private queueStartedAt = 0;
  private currentTaskId: string | null = null;
  private currentTrigger: TaskTrigger = 'manual';
  private activeSignal: CancellationToken | null = null;

  isRunning(): boolean {
    return this.running;
  }

  /** 强制停止：置中止、清队列、解介入、复位运行时 */
  async stop(reason = '用户强制停止'): Promise<{ stopped: boolean; reason: string }> {
    this.activeSignal?.abort();
    this.queue.length = 0;
    this.drainToken += 1;
    abortPendingIntervention();
    this.running = false;
    this.queueStartedAt = 0;
    await setRuntime({
      state: RUN_STATE.IDLE,
      currentSiteId: null,
      currentSiteName: null,
      queue: [],
      message: reason,
    });
    // drain 的 finally 因 myToken !== drainToken 会整块跳过（含徽标刷新），
    // 所以停止路径必须自己更新徽标，否则工具栏红点停留在旧状态。
    await updateBadgeFromLogs();
    return { stopped: true, reason };
  }

  /** 将站点加入串行队列 */
  enqueue(siteIds: string[], { reason = 'manual' }: { reason?: string } = {}): void {
    // 若上次任务异常卡住超过 3 分钟，自动复位
    if (this.running && this.queueStartedAt && Date.now() - this.queueStartedAt > 3 * 60 * 1000) {
      console.warn('[runner] queue stuck, auto-reset');
      this.activeSignal?.abort();
      this.running = false;
      this.queue.length = 0;
    }

    const isNewBatch = !this.running && this.queue.length === 0;
    let trigger: TaskTrigger;
    if (reason === 'manual-force' && siteIds.length === 1) trigger = 'single';
    else if (reason === 'schedule') trigger = 'schedule';
    else trigger = 'manual';
    if (isNewBatch) this.currentTrigger = trigger;

    for (const id of siteIds) this.queue.push({ siteId: id, reason });

    if (!this.running) {
      // 新批次：建一个全新的未中止信号交给 drain。
      // 已在运行时只追加到队列尾部，复用当前 drain 的信号——
      // 绝不能 abort 当前信号，否则会把正在跑的整批任务杀掉。
      const signal = new CancellationToken();
      this.activeSignal = signal;
      void this.drain(signal);
    }
  }

  private async drain(signal: CancellationToken): Promise<void> {
    if (this.running) return;
    const myToken = ++this.drainToken;
    this.running = true;
    this.queueStartedAt = Date.now();
    const settings = await getSettings();
    const results: Log[] = [];

    const taskRecord = await startTask({
      trigger: this.currentTrigger || 'manual',
      state: 'running',
      total: this.queue.length,
    });
    this.currentTaskId = taskRecord.id;

    try {
      await setRuntime({
        state: RUN_STATE.RUNNING,
        message: '执行队列启动',
        queue: this.queue.map((q) => q.siteId),
        taskId: taskRecord.id,
      });

      while (this.queue.length) {
        if (signal.isAborted || myToken !== this.drainToken) break;
        const job = this.queue.shift()!;
        await setRuntime({
          state: RUN_STATE.RUNNING,
          currentSiteId: job.siteId,
          queue: this.queue.map((q) => q.siteId),
        });

        const site = await getSite(job.siteId);
        if (!site) continue;
        if (!site.enabled && job.reason !== 'manual-force') {
          const log = await this.finishSite(site, {
            status: 'skipped',
            message: '站点已禁用',
            startedAt: Date.now(),
            finishedAt: Date.now(),
            cfWaitedMs: 0,
          });
          results.push(log);
          continue;
        }

        await setRuntime({
          currentSiteName: site.name,
          message: `正在执行：${site.name}`,
        });

        const hardTimeout = this.computeHardTimeout(site, settings);
        signal.setDeadline(hardTimeout);
        let result: RunOutcome;
        try {
          result = await this.runOneSite(site, settings, signal);
        } catch (e) {
          result = {
            status: signal.isAborted ? 'skipped' : 'failed',
            message: (e as Error)?.message || String(e),
            startedAt: Date.now(),
            finishedAt: Date.now(),
            cfWaitedMs: 0,
          };
          // 致命错误下留着标签无意义，由 RunContext 内部已关；这里兜底
          if (isFatal(e)) {
            /* tab 已由 ctx 收尾 */
          }
        } finally {
          signal.clearDeadline();
        }

        if (signal.isAborted && result.status === 'failed') {
          result = { ...result, status: 'skipped', message: result.message || '已取消' };
        }

        const log = await this.finishSite(site, result);
        results.push(log);

        if (signal.isAborted || myToken !== this.drainToken) break;
        if (this.queue.length && settings.siteGapMs > 0) {
          try {
            await signal.sleep(settings.siteGapMs);
          } catch {
            break;
          }
        }
      }
    } finally {
      if (myToken === this.drainToken) {
        this.running = false;
        const wasAbort = signal.isAborted;
        this.queueStartedAt = 0;
        await setRuntime({
          state: RUN_STATE.IDLE,
          currentSiteId: null,
          currentSiteName: null,
          queue: [],
          message: wasAbort ? '已停止' : '空闲',
        });

        if (this.currentTaskId) {
          const success = results.filter((r) => r.status === 'success').length;
          const failed = results.filter(
            (r) => r.status === 'failed' || r.status === 'cf_timeout' || r.status === 'need_login'
          ).length;
          const skipped = results.filter((r) => r.status === 'skipped').length;
          await upsertTask({
            id: this.currentTaskId,
            state: wasAbort ? 'aborted' : 'done',
            finishedAt: Date.now(),
            total: results.length,
            success,
            failed,
            skipped,
          });
          this.currentTaskId = null;
        }

        await updateBadgeFromLogs();
        if (!wasAbort) await notifySummary(results, settings);
      }
    }
  }

  private computeHardTimeout(site: Site & LegacySite, settings: Settings): number {
    return (
      (site.login?.enabled ? site.login.timeoutMs || 180000 : 0) +
      (site.verificationProcedureId ? 180000 : 0) +
      (site.cfTimeoutMs || settings.defaultCfTimeoutMs || 90000) +
      (settings.cfManualGraceMs || 120000) +
      (site.stepsTimeoutMs || 120000) +
      (site.pageLoadTimeoutMs || settings.defaultPageLoadTimeoutMs || 45000) +
      30000
    );
  }

  private async runOneSite(
    site: Site & LegacySite,
    settings: Settings,
    signal: CancellationToken
  ): Promise<RunOutcome> {
    const { checkinProc, loginProc, verificationProc } = await this.resolveProcedures(site);
    if (!checkinProc) {
      return {
        status: 'failed',
        message: '该站点未选择自动化技能，请到设置中选择或新建一个',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        cfWaitedMs: 0,
      };
    }

    const target: RunTarget = {
      url: site.url,
      name: site.name,
      mode: site.mode,
      stepsTimeoutMs: site.stepsTimeoutMs || 120000,
      pageLoadTimeoutMs: site.pageLoadTimeoutMs || settings.defaultPageLoadTimeoutMs || 45000,
      cfTimeoutMs: site.cfTimeoutMs || settings.defaultCfTimeoutMs || 90000,
      keepTabOnError: site.keepTabOnError,
      openInBackground:
        site.openInBackground !== undefined ? site.openInBackground : settings.openInBackground,
    };

    const ctx = new RunContext({
      settings,
      checkinProc,
      loginProc,
      verificationProc,
      signal,
      target,
    });
    return ctx.run();
  }

  /** 取站点绑定的自动化/登录/验证技能；缺失时回退到内联旧字段 */
  private async resolveProcedures(
    site: Site & LegacySite
  ): Promise<{
    checkinProc: CheckinProcedure | null;
    loginProc: LoginProcedure | null;
    verificationProc: VerificationProcedure | null;
  }> {
    let checkinProc: CheckinProcedure | null = null;
    let loginProc: LoginProcedure | null = null;
    let verificationProc: VerificationProcedure | null = null;

    if (site.checkinProcedureId) {
      const p = await getProcedure(site.checkinProcedureId);
      if (p && p.kind === 'checkin' && p.siteId === site.id) checkinProc = p;
    }
    if (!checkinProc && Array.isArray(site.steps) && site.steps.length) {
      checkinProc = {
        id: '',
        siteId: site.id,
        kind: 'checkin',
        name: '执行（内联）',
        description: '',
        detect: {
          successKeywords: site.successKeywords || [],
          failKeywords: site.failKeywords || [],
        },
        steps: site.steps,
        script: site.script || '',
        source: 'local',
        author: '',
        homepage: '',
        version: '1.0.0',
        marketId: '',
        installedAt: 0,
        updatedAt: 0,
        createdAt: 0,
        lastResult: null,
        explorationHistory: [],
        patchHistory: [],
        output: { enabled: false, fields: [] },
      };
    }

    if (site.loginProcedureId) {
      const p = await getProcedure(site.loginProcedureId);
      if (p && p.kind === 'login' && p.siteId === site.id) loginProc = p;
    } else if (site.login?.enabled && Array.isArray(site.login.steps) && site.login.steps.length) {
      const login = site.login;
      loginProc = {
        id: '',
        siteId: site.id,
        kind: 'login',
        name: '登录（内联）',
        description: '',
        detect: {
          loggedInSelector: login.loggedInSelector || '',
          loggedInUrlIncludes: login.loggedInUrlIncludes || '',
          loginUrlPattern: '',
          notLoggedInKeywords: ['请登录', '登录后操作', '您需要登录'],
        },
        steps: login.steps,
        timeoutMs: login.timeoutMs || 180000,
        script: '',
        source: 'local',
        author: '',
        homepage: '',
        version: '1.0.0',
        marketId: '',
        installedAt: 0,
        updatedAt: 0,
        createdAt: 0,
        lastResult: null,
        explorationHistory: [],
        patchHistory: [],
        output: { enabled: false, fields: [] },
      } as LoginProcedure;
    }
    if (site.verificationProcedureId) {
      const p = await getProcedure(site.verificationProcedureId);
      if (p && p.kind === 'verification' && p.siteId === site.id) verificationProc = p;
    }
    return { checkinProc, loginProc, verificationProc };
  }

  private async finishSite(site: Site, result: RunOutcome): Promise<Log> {
    const finishedAt = result.finishedAt || Date.now();
    const lastResult = {
      status: result.status as RunStatus,
      message: result.message,
      at: finishedAt,
    };
    await updateSiteLastResult(site.id, lastResult);
    return appendLog({
      taskId: this.currentTaskId || '',
      siteId: site.id,
      siteName: site.name,
      status: result.status,
      message: result.message,
      startedAt: result.startedAt,
      finishedAt,
      cfWaitedMs: result.cfWaitedMs || 0,
    });
  }
}

export const executionQueue = new ExecutionQueue();

// 让 run-context 能查询队列是否在运行（避免循环依赖）
setQueueRunningHook(() => executionQueue.isRunning());

// —— 对外的薄封装，保持 service-worker 的导入面稳定 ——

export function isQueueRunning(): boolean {
  return executionQueue.isRunning();
}

export function enqueueSites(
  siteIds: string[],
  opts?: { reason?: string }
): void {
  return executionQueue.enqueue(siteIds, opts);
}

export function stopQueue(reason?: string): Promise<{ stopped: boolean; reason: string }> {
  return executionQueue.stop(reason);
}
