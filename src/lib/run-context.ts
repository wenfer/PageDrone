/**
 * RunContext：一次「打开标签 → 等待加载/CF → 登录 → 执行步骤/脚本 → 关键词判定 → 收尾」的执行。
 * 吸收原 runner.js 里 runOneSite 与 runProcedureStandalone 的平行结构，
 * 用实例字段（tab/signal/cfWaitedMs）替代层层透传的 tabId/settings 与模块级 abort/deadline。
 */

import {
  getSettings,
  getProcedure,
  upsertProcedure,
  getSites,
  setRuntime,
} from './storage.js';
import { RUN_STATE } from './messaging.js';
import {
  detectChallengeInPage,
  hasCfClearance,
  isChallengeCleared,
} from './cf.js';
import { CancellationToken } from './cancellation.js';
import { TabSession, buildMatcher } from './tab-session.js';
import {
  AbortedError,
  TabGoneError,
  HttpError,
  LoginRedirectError,
  isFatal,
} from './errors.js';
import { pageQueryExists } from './page/selectors.js';
import { pageRunOneStep, type PageStepResult } from './page/steps.js';
import { pageRunUserScript, type UserScriptResult } from './page/user-script.js';
import { pageExtractData, type PageExtractResult } from './page/extract.js';
import type {
  Procedure,
  ExecutableProcedure,
  LoginProcedure,
  VerificationProcedure,
  LoginDetect,
  Settings,
  SiteMode,
  RunStatus,
  Step,
} from './models.js';
import type {
  RunOutcome,
  InterventionDecision,
  InterventionContext,
  ExecutionResult,
} from './types.js';

function newToken(prefix = 'itv'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// —— 偏差介入：全局单槽（同一时刻只可能有一个挂起的介入）——

interface PendingIntervention {
  token: string;
  resolve: (decision: InterventionDecision) => void;
}
let pendingIntervention: PendingIntervention | null = null;

interface StepOutput {
  name: string;
  value: unknown;
}

/** 前端对一次介入作出决策后调用（经 INTERVENTION_RESOLVE 消息） */
export function resolveIntervention(
  token: string,
  decision: InterventionDecision
): { ok: boolean; message?: string } {
  if (pendingIntervention && pendingIntervention.token === token) {
    const { resolve } = pendingIntervention;
    pendingIntervention = null;
    resolve(decision || { action: 'abort' });
    return { ok: true };
  }
  return { ok: false, message: '没有匹配的待介入步骤（可能已超时或已处理）' };
}

/** 若当前有挂起的介入，直接以「终止」解开 */
export function abortPendingIntervention(): void {
  if (pendingIntervention) {
    const { resolve } = pendingIntervention;
    pendingIntervention = null;
    resolve({ action: 'abort' });
  }
}

/** 发一条桌面通知；通知失败不影响主流程 */
function notify(
  settings: Settings,
  id: string,
  title: string,
  message: string,
  priority?: number
): void {
  if (settings && settings.notifyOnError === false) return;
  try {
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
      ...(priority ? { priority: priority as chrome.notifications.NotificationOptions['priority'] } : {}),
    });
  } catch {
    /* 通知不是主流程，失败无所谓 */
  }
}

/** 把一次步骤修复写回技能（patchHistory + steps[stepIndex]） */
async function recordStepPatch(
  procId: string,
  stepIndex: number,
  before: Step,
  after: Step,
  trigger: 'human' | 'llm' = 'human',
  reason = ''
): Promise<void> {
  if (!procId) return;
  try {
    const proc = await getProcedure(procId);
    if (!proc || !Array.isArray(proc.steps)) return;
    const patch = {
      id: newToken('patch'),
      stepIndex,
      before,
      after,
      trigger,
      reason,
      at: Date.now(),
    };
    const steps = proc.steps.slice();
    steps[stepIndex] = after;
    const patchHistory = Array.isArray(proc.patchHistory) ? proc.patchHistory.slice() : [];
    patchHistory.push(patch);
    await upsertProcedure({ ...proc, steps, patchHistory });
  } catch (e) {
    console.warn('[runner] recordStepPatch failed:', (e as Error)?.message || e);
  }
}

function inferFailStatus(message = ''): RunStatus {
  if (/登录|未登录|login/i.test(message)) return 'need_login';
  return 'failed';
}

function judgeKeywordsByProc(
  text: string,
  proc: Procedure
): { ok: boolean; message: string } | null {
  if (!text || proc.kind !== 'checkin') return null;
  const detect = proc.detect;
  const fails = detect.failKeywords || [];
  const successes = detect.successKeywords || [];
  for (const k of fails) {
    if (k && text.includes(k)) {
      if (/登录|login/i.test(k)) continue; // 登录词交给 need_login 逻辑
      return { ok: false, message: `匹配失败关键词：${k}` };
    }
  }
  for (const k of successes) {
    if (k && text.includes(k)) {
      return { ok: true, message: `匹配成功关键词：${k}` };
    }
  }
  return null;
}

export interface RunTarget {
  url: string;
  name: string;
  mode: SiteMode;
  stepsTimeoutMs: number;
  pageLoadTimeoutMs: number;
  cfTimeoutMs: number;
  keepTabOnError: boolean;
  openInBackground: boolean;
}

export interface RunContextOptions {
  settings: Settings;
  checkinProc: ExecutableProcedure;
  loginProc: LoginProcedure | null;
  verificationProc?: VerificationProcedure | null;
  signal: CancellationToken;
  target: RunTarget;
  /** 独立技能运行（画布「调用技能」节点）：无站点、不写站点日志 */
  standalone?: boolean;
  keepTab?: boolean;
  active?: boolean;
  watchDeviation?: boolean;
}

export class RunContext {
  private readonly settings: Settings;
  private readonly checkinProc: ExecutableProcedure;
  private readonly loginProc: LoginProcedure | null;
  private readonly verificationProc: VerificationProcedure | null;
  private readonly signal: CancellationToken;
  private readonly target: RunTarget;
  private readonly standalone: boolean;
  private readonly keepTab: boolean;
  private readonly openActive: boolean;
  private readonly watchDeviation: boolean;

  private tab: TabSession | null = null;
  /** 本次运行创建或接管的全部标签页；跨标签技能成功收尾时一并清理。 */
  private ownedTabs: TabSession[] = [];
  private cfWaitedMs = 0;
  private activeVerificationProc: VerificationProcedure | null = null;
  private readonly startedAt: number;

  constructor(opts: RunContextOptions) {
    this.settings = opts.settings;
    this.checkinProc = opts.checkinProc;
    this.loginProc = opts.loginProc;
    this.verificationProc = opts.verificationProc || null;
    this.signal = opts.signal;
    this.target = opts.target;
    this.standalone = !!opts.standalone;
    this.keepTab = !!opts.keepTab;
    this.openActive = opts.active !== false;
    this.watchDeviation = !!opts.watchDeviation;
    this.startedAt = Date.now();
  }

  private notify(title: string, message: string, priority?: number): void {
    notify(this.settings, newToken('n'), title, message, priority);
  }

  async run(): Promise<RunOutcome> {
    const { target } = this;
    const pageLoadTimeout = target.pageLoadTimeoutMs;
    const cfTimeout = target.cfTimeoutMs;

    try {
      if (this.signal.isAborted) throw new AbortedError();
      this.tab = await TabSession.create(
        { url: target.url, active: this.standalone ? this.openActive : !target.openInBackground },
        this.signal
      );
      this.ownedTabs = [this.tab];

      await this.tab.waitComplete(pageLoadTimeout);
      await this.tab.assertAlive();

      // 快速识别网关错误页，避免在 502/404 页上傻等步骤超时
      await this.detectBootError();

      // 普通自动化技能先通过防护门；验证技能本身必须能在防护页上运行，
      // 独立调用时不能在执行自己的步骤之前被防护门拦住。
      if (this.checkinProc.kind !== 'verification') {
        await setRuntime({
          state: RUN_STATE.WAITING_CF,
          message: `等待防护通过：${target.name}`,
        });
        const cf = await this.waitForChallengeClear(target.url, cfTimeout);
        this.cfWaitedMs = cf.waited;
        if (!cf.ok) {
          if (target.keepTabOnError !== false) await this.tab.focus();
          return this.outcome('cf_timeout', cf.message || '人机验证超时，请手动完成后重试');
        }
      }

      // 开始前登录检查
      if (this.loginProc) {
        const lr = await this.ensureLoggedIn('precheck', cfTimeout);
        if (!lr.ok) {
          return this.outcome(lr.status || 'need_login', lr.message);
        }
        this.cfWaitedMs += lr.cfWaitedMs || 0;
      }

      await setRuntime({ state: RUN_STATE.RUNNING, message: `执行：${target.name}` });

      // 执行自动化技能；失败且检测到掉线时自动重登并重试一次
      let execResult: ExecutionResult;
      let loginRetryUsed = false;

      try {
        execResult = await this.runCheckinProcedure();
      } catch (e) {
        // 取消 / 标签关闭 / 超时不能降级成「执行失败」，否则会继续走重登流程
        if (isFatal(e)) throw e;
        execResult = { ok: false, message: (e as Error)?.message || String(e), needKeywordCheck: true };
      }

      if (this.loginProc && !loginRetryUsed) {
        const relogin = await this.maybeRelogin(execResult, loginRetryUsed);
        if (relogin) {
          loginRetryUsed = true;
          const lr = await this.ensureLoggedIn(relogin.reason, cfTimeout);
          if (!lr.ok) return this.outcome(lr.status || 'need_login', lr.message);
          this.cfWaitedMs += lr.cfWaitedMs || 0;
          await this.returnToTargetAfterLogin(pageLoadTimeout, cfTimeout);
          try {
            execResult = await this.runCheckinProcedure();
          } catch (e) {
            execResult = { ok: false, message: (e as Error)?.message || String(e), needKeywordCheck: true };
          }
        }
      }

      // 关键词二次判定
      execResult = await this.judgeKeywords(execResult);
      if (this.checkinProc.kind === 'verification' && execResult.ok) {
        const cleared = await this.isVerificationActionCleared(this.checkinProc);
        if (!cleared) {
          execResult = { ...execResult, ok: false, message: '验证技能已执行，但页面验证状态仍未解除' };
        }
      }

      let status: RunStatus = execResult.ok ? 'success' : inferFailStatus(execResult.message);
      if (!execResult.ok && this.loginProc && loginRetryUsed) {
        const stillLoggedOut = await this.looksLikeLoggedOut(execResult.message);
        if (stillLoggedOut) status = 'need_login';
      }

      let message = execResult.message || (execResult.ok ? '执行成功' : '执行失败');
      if (loginRetryUsed && execResult.ok) {
        message = `自动重登后重试成功 · ${message}`;
      }

      await this.finalizeTab(status);
      return this.outcome(status, message, execResult);
    } catch (e) {
      return this.handleRunError(e);
    }
  }

  private outcome(status: RunStatus, message: string, execResult?: ExecutionResult): RunOutcome {
    return {
      status,
      message,
      startedAt: this.startedAt,
      finishedAt: Date.now(),
      cfWaitedMs: this.cfWaitedMs,
      tabId: this.standalone ? this.tab?.id ?? null : undefined,
      ...(execResult?.outputs ? { outputs: execResult.outputs } : {}),
      ...(execResult && Object.prototype.hasOwnProperty.call(execResult, 'returnValue')
        ? { returnValue: execResult.returnValue }
        : {}),
    };
  }

  private async detectBootError(): Promise<void> {
    if (!this.tab) return;
    try {
      const boot = await this.tab.inject(
        (): { title: string; httpError: string | null } => {
          const t = `${document.title || ''} ${(document.body?.innerText || '').slice(0, 500)}`;
          const m = t.match(/\b(502|503|504|500|404)\b/);
          return { title: document.title || '', httpError: m ? m[1]! : null };
        }
      );
      if (boot?.httpError) throw new HttpError(Number(boot.httpError), boot.title || '');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      // 注入失败可能是受限页，继续走后续步骤
    }
  }

  // —— 登录 ——

  private async isLoggedInProc(detect: Partial<LoginDetect>): Promise<boolean> {
    if (!this.tab) return false;
    try {
      if (detect.loggedInUrlIncludes) {
        const tab = await this.tab.get();
        if (tab.url && tab.url.includes(detect.loggedInUrlIncludes)) return true;
      }
      if (detect.loggedInSelector) {
        const exists = await this.tab.inject(pageQueryExists, [detect.loggedInSelector]);
        if (exists) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async ensureLoggedIn(
    reason: string,
    cfTimeout: number
  ): Promise<{ ok: boolean; status?: RunStatus; message: string; cfWaitedMs?: number }> {
    if (!this.loginProc || !this.tab) return { ok: true, message: '', cfWaitedMs: 0 };
    const detect = this.loginProc.detect;
    const loggedIn = await this.isLoggedInProc(detect);
    if (loggedIn) return { ok: true, message: '', cfWaitedMs: 0 };

    const reasonLabel =
      ({
        precheck: '开始前检查',
        step_failed: '操作步骤失败',
        keyword: '命中未登录关键词',
        url_redirect: '跳转到登录页',
      } as Record<string, string>)[reason] || reason;

    await setRuntime({
      state: RUN_STATE.NEED_MANUAL,
      message: `需要登录（${reasonLabel}）：${this.loginProc.name || ''}`,
    });

    const loginTimeout = this.loginProc.timeoutMs || 180000;
    const loginResult = await this.executeSteps(this.loginProc.steps || [], loginTimeout, {
      label: '登录',
    });
    if (!loginResult.ok) {
      return {
        ok: false,
        status: 'need_login',
        message: `自动登录失败（${reasonLabel}）：${loginResult.message || '未完成'}`,
      };
    }
    const after = await this.isLoggedInProc(detect);
    if (!after && (detect.loggedInSelector || detect.loggedInUrlIncludes)) {
      return {
        ok: false,
        status: 'need_login',
        message: `登录步骤已完成但仍未检测到登录态（${reasonLabel}）`,
      };
    }
    try {
      const tab = await this.tab.get();
      const cf = await this.waitForChallengeClear(
        tab.url || 'https://example.com',
        Math.min(cfTimeout, 60000)
      );
      return { ok: true, cfWaitedMs: cf.waited || 0, message: '' };
    } catch (e) {
      if (isFatal(e)) throw e;
      return { ok: true, cfWaitedMs: 0, message: '' };
    }
  }

  private async looksLikeLoggedOut(errMessage: string): Promise<boolean> {
    if (!this.loginProc || !this.tab) return false;
    const detect = this.loginProc.detect;
    if (detect.loginUrlPattern) {
      try {
        const url = await this.tab.url;
        if (buildMatcher(detect.loginUrlPattern)(url)) return true;
      } catch {
        /* tab gone */
      }
    }
    if (errMessage && /登录|未登录|please\s*sign?\s*in|login\s*required/i.test(errMessage)) {
      return true;
    }
    const kws = detect.notLoggedInKeywords || [];
    if (kws.length) {
      const text = await this.tab.getText();
      if (text && kws.some((k) => k && text.includes(k))) return true;
    }
    if (this.checkinProc.kind === 'checkin') {
      const failKws = this.checkinProc.detect.failKeywords || [];
      if (errMessage && failKws.some((k) => /登录|login/i.test(k) && errMessage.includes(k))) {
        return true;
      }
    }
    return false;
  }

  private async maybeRelogin(
    execResult: ExecutionResult,
    _loginRetryUsed: boolean
  ): Promise<{ reason: string } | null> {
    let needRelogin = !!execResult.loginRedirect;
    if (!needRelogin) {
      const loggedOut = await this.looksLikeLoggedOut(
        execResult.ok ? '' : execResult.message
      );
      if (loggedOut) {
        if (execResult.ok) {
          const text = await this.tab?.getText();
          const hitSuccess =
            !!text &&
            this.checkinProc.kind === 'checkin' &&
            (this.checkinProc.detect.successKeywords || []).some((k) => k && text.includes(k));
          needRelogin = !hitSuccess;
        } else {
          needRelogin = true;
        }
      }
    }
    if (!needRelogin) return null;
    let reason = 'step_failed';
    if (execResult.loginRedirect) reason = 'url_redirect';
    else if (/关键词|请登录/.test(execResult.message || '')) reason = 'keyword';
    else if (execResult.ok) reason = 'url_redirect';
    return { reason };
  }

  private async returnToTargetAfterLogin(
    pageLoadTimeout: number,
    cfTimeout: number
  ): Promise<void> {
    if (!this.tab) return;
    try {
      const tab = await this.tab.get();
      if (tab.url !== this.target.url && !tab.url?.includes(new URL(this.target.url).host)) {
        await chrome.tabs.update(this.tab.id, { url: this.target.url });
        await this.tab.waitComplete(pageLoadTimeout);
        const cf2 = await this.waitForChallengeClear(
          this.target.url,
          Math.min(cfTimeout, 60000)
        );
        this.cfWaitedMs += cf2.waited || 0;
      }
    } catch {
      /* ignore */
    }
  }

  // —— 执行技能 ——

  private async runCheckinProcedure(): Promise<ExecutionResult> {
    if (this.checkinProc.kind === 'verification') {
      return this.applyProcedureOutput(await this.executeVerificationAction(this.checkinProc));
    }
    const useScript =
      this.target.mode === 'script' ||
      (this.checkinProc.steps?.length === 0 && !!this.checkinProc.script);
    if (useScript) {
      const result = await this.executeUserScript(this.checkinProc.script || '', 60000);
      return this.applyProcedureOutput(result, result.data === undefined ? undefined : { result: result.data });
    }
    const stepsTimeout = this.target.stepsTimeoutMs;
    const result = await this.executeSteps(this.checkinProc.steps || [], stepsTimeout, {
      label: '执行',
      // 优先用登录技能配置的 loginUrlPattern；自动化技能也可自带
      loginUrlPattern:
        this.loginProc?.detect.loginUrlPattern ||
        (this.checkinProc.kind === 'checkin'
          ? this.checkinProc.detect.loginUrlPattern || ''
          : ''),
      onDeviation: this.watchDeviation,
      procId: this.watchDeviation ? this.checkinProc.id : '',
    });
    return this.applyProcedureOutput(result);
  }

  /** 根据技能的显式返回契约筛选原子操作结果，避免默认暴露页面数据。 */
  private applyProcedureOutput(
    result: ExecutionResult,
    scriptOutput?: Record<string, unknown>
  ): ExecutionResult {
    const spec = this.checkinProc.output;
    if (!spec?.enabled) return { ...result, outputs: undefined, returnValue: undefined };
    const all = { ...(result.outputs || {}), ...(scriptOutput || {}) };
    const fields = Array.isArray(spec.fields) ? spec.fields.filter(Boolean) : [];
    const selected = fields.length
      ? Object.fromEntries(fields.filter((field) => Object.prototype.hasOwnProperty.call(all, field)).map((field) => [field, all[field]]))
      : all;
    const names = Object.keys(selected);
    if (!names.length) {
      return { ...result, outputs: {}, returnValue: null };
    }
    return {
      ...result,
      outputs: selected,
      returnValue: names.length === 1 ? selected[names[0]!] : selected,
    };
  }

  private async judgeKeywords(execResult: ExecutionResult): Promise<ExecutionResult> {
    if (execResult.needKeywordCheck === false) return execResult;
    const text = await this.tab?.getText();
    if (text === undefined || text === null) {
      if (execResult.ok) {
        return {
          ...execResult,
          message: `${execResult.message || '执行完成'}（未能读取页面，关键词未核实）`,
        };
      }
      return execResult;
    }
    const kw = judgeKeywordsByProc(text, this.checkinProc);
    if (kw) return { ...execResult, ...kw };
    return execResult;
  }

  private async executeSteps(
    steps: Step[],
    totalTimeoutMs: number,
    opts: { label?: string; loginUrlPattern?: string; onDeviation?: boolean; procId?: string } = {}
  ): Promise<ExecutionResult> {
    const { label = '步骤', loginUrlPattern = '', onDeviation = false, procId = '' } = opts;
    const list = steps || [];
    if (!list.length) {
      return { ok: true, message: `无${label}可执行`, needKeywordCheck: true };
    }
    const outputs: Record<string, unknown> = {};
    const deadline = Date.now() + (totalTimeoutMs || 120000);
    const urlMatcher = loginUrlPattern ? buildMatcher(loginUrlPattern) : null;
    try {
      for (let i = 0; i < list.length; i++) {
        if (Date.now() > deadline) throw new Error(`${label}总超时`);
        if (urlMatcher && this.tab) {
          let tab: chrome.tabs.Tab;
          try {
            tab = await this.tab.get();
          } catch {
            throw new TabGoneError();
          }
          if (tab.url && urlMatcher(tab.url)) {
            throw new LoginRedirectError(`地址跳转到登录页：${tab.url}`);
          }
        }
        const step = list[i]!;
        await setRuntime({ message: `执行${label} ${i + 1}/${list.length}：${step.type}` });

        if (onDeviation) {
          let done = false;
          while (!done) {
            if (Date.now() > deadline) throw new Error(`${label}总超时`);
            try {
              const output = await this.runOneStep(step, deadline, i);
              if (output) outputs[output.name] = output.value;
              done = true;
            } catch (stepErr) {
              if (stepErr instanceof LoginRedirectError) throw stepErr;
              if (this.signal.isAborted) throw stepErr;
              const decision = await this.awaitIntervention({
                procId,
                stepIndex: i,
                step,
                error: (stepErr as Error)?.message || String(stepErr),
                tabId: this.tab!.id,
              });
              await setRuntime({ state: RUN_STATE.RUNNING, message: `继续执行${label}` });
              if (decision.action === 'skip') {
                done = true;
              } else if (decision.action === 'patch' && decision.patchStep) {
                await recordStepPatch(procId, i, step, decision.patchStep, 'human', '执行时人工修复');
                list[i] = decision.patchStep;
              } else if (decision.action === 'retry') {
                // 继续循环重试
              } else {
                throw new Error('用户终止了执行');
              }
            }
          }
        } else {
          const output = await this.runOneStep(step, deadline, i);
          if (output) outputs[output.name] = output.value;
        }
      }
      return {
        ok: true,
        message: `已完成 ${list.length} 个${label}`,
        needKeywordCheck: true,
        ...(Object.keys(outputs).length ? { outputs } : {}),
      };
    } catch (e) {
      if (isFatal(e)) throw e;
      return {
        ok: false,
        message: (e as Error)?.message || String(e),
        loginRedirect: e instanceof LoginRedirectError,
        needKeywordCheck: true,
      };
    }
  }

  private async runOneStep(step: Step, deadline: number, stepIndex = 0): Promise<StepOutput | null> {
    const remain = () => Math.max(1000, (deadline || Date.now() + 60000) - Date.now());

    if (step.type === 'wait') {
      await this.signal.sleep(Number(step.ms) || 1000);
      return null;
    }

    if (step.type === 'goto') {
      // selector 是旧版/市场技能里装 URL 的字段，保留兼容
      const url = step.url || step.selector;
      if (!url) throw new Error('goto 缺少 url');
      if (!this.tab) throw new TabGoneError();
      await chrome.tabs.update(this.tab.id, { url });
      await this.tab.waitComplete(Number(step.timeoutMs) || 45000);
      return null;
    }

    if (step.type === 'waitForUrl') {
      // 兼容 match / includes / url / selector 四种字段名
      const match = step.match || step.includes || step.url || step.selector || '';
      if (!match) throw new Error('waitForUrl 缺少匹配串（match）');
      await this.tab!.waitUrl(match, Number(step.timeoutMs) || remain());
      await this.signal.sleep(500);
      return null;
    }

    if (step.type === 'manual') {
      await this.waitManualAuth(step, remain());
      return null;
    }

    if (step.type === 'extract') {
      if (!this.tab) throw new TabGoneError();
      const selector = String(step.selector || '').trim();
      if (!selector) throw new Error('extract 缺少 selector');
      const extractDeadline = Date.now() + Math.max(500, Number(step.timeoutMs) || remain());
      let extracted: PageExtractResult | undefined;
      while (Date.now() < extractDeadline) {
        const result = await this.tab.inject(pageExtractData, [{
          selector,
          mode: step.mode || 'text',
          attribute: step.attribute || '',
          multiple: step.multiple === true,
        }]);
        extracted = result as PageExtractResult | undefined;
        if (extracted?.ok) break;
        await this.signal.sleep(250);
      }
      if (!extracted?.ok) {
        if (step.required === false) {
          return { name: step.variable || `step_${stepIndex + 1}`, value: null };
        }
        throw new Error(extracted?.message || `提取失败：${selector}`);
      }
      return {
        name: step.variable || `step_${stepIndex + 1}`,
        value: extracted.data,
      };
    }

    if (step.type === 'click') {
      if (!this.tab) throw new TabGoneError();
      let beforeUrl = '';
      try {
        beforeUrl = (await this.tab.get()).url || '';
      } catch {
        throw new TabGoneError();
      }
      const beforeIds = new Set((await chrome.tabs.query({})).map((t) => t.id));

      let pageResult: PageStepResult = { ok: false, message: '点击未执行' };
      try {
        pageResult = await this.executePageStep(step, 2);
      } catch (e) {
        pageResult = { ok: false, message: (e as Error)?.message || String(e) };
      }

      const autoNav = step.waitNavigation !== false;
      let navigated = false;
      if (autoNav) {
        const nav = await this.waitForPossibleNavigation(
          beforeUrl,
          Number(step.navTimeoutMs) || Number(step.timeoutMs) || 45000
        );
        navigated = !!nav.navigated;
      }

      if (!pageResult?.ok && !navigated) {
        throw new Error(pageResult?.message || '点击失败');
      }

      if (step.followPopup) {
        const popup = await this.waitForPopupTab(
          beforeIds,
          Number(step.popupTimeoutMs) || Number(step.timeoutMs) || remain()
        );
        if (!popup) throw new Error('点击后未发现新标签页');
        this.tab = popup;
        this.ownedTabs.push(popup);
      } else if (step.watchPopup) {
        await this.waitOAuthPopupOrReturn(beforeIds, step, remain());
      }
      return null;
    }

    // 页内步骤：waitFor / waitForText / type
    const pageResult = await this.executePageStep(step, 8);
    if (!pageResult?.ok) throw new Error(pageResult?.message || `${step.type} 失败`);
    return null;
  }

  private async waitForPossibleNavigation(
    beforeUrl: string,
    timeoutMs: number
  ): Promise<{ navigated: boolean }> {
    if (!this.tab) return { navigated: false };
    const detectMs = 2500;
    const detectEnd = Date.now() + detectMs;
    let navigated = false;

    while (Date.now() < detectEnd) {
      if (this.signal.isAborted) throw new AbortedError();
      try {
        const t = await this.tab.get();
        if (t.status === 'loading') {
          navigated = true;
          break;
        }
        if (beforeUrl && t.url && t.url !== beforeUrl) {
          navigated = true;
          break;
        }
      } catch {
        throw new TabGoneError();
      }
      await this.signal.sleep(120);
    }

    try {
      await this.tab.waitComplete(timeoutMs);
    } catch (e) {
      if (this.signal.isAborted || isFatal(e)) throw e;
      // 加载超时但标签仍在：继续，由后续 waitForText 判定
    }

    if (navigated && !this.activeVerificationProc) {
      try {
        const tab = await this.tab.get();
        await this.waitForChallengeClear(
          tab.url || beforeUrl || 'https://example.com',
          Math.min(30000, timeoutMs)
        );
      } catch (e) {
        if (this.signal.isAborted || isFatal(e)) throw e;
      }
    }
    return { navigated };
  }

  private async executePageStep(step: Step, maxAttempts = 6): Promise<PageStepResult> {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.signal.isAborted) throw new AbortedError();
      if (!this.tab) throw new TabGoneError();
      await this.tab.assertAlive();

      try {
        const tab = await this.tab.get();
        if (tab.status !== 'complete') {
          await this.tab.waitComplete(45000);
        }
      } catch (e) {
        if (isFatal(e)) throw e;
      }

      try {
        const result = await this.tab.inject(pageRunOneStep, [step as never]);
        if (result?.ok) return result;
        lastErr = new Error(result?.message || '页内步骤失败');
        if (
          attempt < maxAttempts &&
          /超时|跳转|frame|destroyed|Cannot access/i.test(result?.message || '')
        ) {
          await this.signal.sleep(600);
          continue;
        }
        return result || { ok: false, message: '页内步骤无返回' };
      } catch (e) {
        lastErr = e as Error;
        if (attempt < maxAttempts) {
          try {
            await this.signal.sleep(500);
            const t = await this.tab!.get();
            if (t.status === 'loading') await this.tab!.waitComplete(45000);
          } catch (e2) {
            if (isFatal(e2)) throw e2;
          }
          continue;
        }
        return { ok: false, message: lastErr.message };
      }
    }
    return { ok: false, message: lastErr?.message || '页内步骤失败' };
  }

  private async waitManualAuth(step: Step, timeoutMs: number): Promise<void> {
    if (!this.tab || step.type !== 'manual') return;
    const timeout = Number(step.timeoutMs) || timeoutMs || 180000;
    const message = step.message || '请完成登录或 OAuth 授权';
    const match = step.match || step.includes || step.url || '';
    const selector = step.selector || '';

    await this.tab.focus();
    await setRuntime({ state: RUN_STATE.NEED_MANUAL, message });
    this.notify(
      '自动执行 - 需要登录 / OAuth',
      message + (match ? `（完成后等待 URL 含：${match}）` : ''),
      2
    );

    const start = Date.now();
    const tester = match ? buildMatcher(match) : null;
    let stableHits = 0;
    let lastUrl = '';
    while (Date.now() - start < timeout) {
      let url: string;
      try {
        const tab = await this.tab.get();
        url = tab.url || '';
        if (this.activeVerificationProc) {
          const hasProcedureSignal = !!(
            this.activeVerificationProc.detect.completedSelector ||
            this.activeVerificationProc.detect.completedUrlIncludes
          );
          if (
            (hasProcedureSignal || (!tester && !selector)) &&
            await this.isVerificationActionCleared(this.activeVerificationProc)
          ) return;
          // 验证技能未显式配置完成信号时，以通用防护检测为准；不能套用
          // OAuth 的“普通 URL 稳定数秒即成功”启发式，否则会提前恢复流程。
          if (!tester && !selector) {
            await this.signal.sleep(800);
            continue;
          }
        }
        if (tester && url && tester(url)) return;
        if (selector) {
          try {
            const exists = await this.tab.inject(pageQueryExists, [selector]);
            if (exists) return;
          } catch {
            /* 跳转中 */
          }
        }
        if (!tester && !selector && Date.now() - start > 3000) {
          const onOauth =
            /accounts\.google|github\.com\/login|login\.microsoftonline|oauth|authorize|sso\.|auth0\.com|okta\.com/i.test(
              url
            );
          if (!onOauth && url && !url.startsWith('chrome')) {
            if (url === lastUrl) stableHits += 1;
            else {
              lastUrl = url;
              stableHits = 0;
            }
            if (stableHits >= 3) return;
          } else {
            stableHits = 0;
            lastUrl = url;
          }
        }
      } catch {
        throw new TabGoneError('标签页已关闭');
      }
      await this.signal.sleep(800);
    }
    throw new Error(`人工登录 / OAuth 超时：${message}`);
  }

  private async waitOAuthPopupOrReturn(
    beforeIds: Set<number | undefined>,
    step: Step,
    timeoutMs: number
  ): Promise<void> {
    if (!this.tab || step.type !== 'click') return;
    const timeout =
      Number(step.popupTimeoutMs) || Number(step.timeoutMs) || timeoutMs || 180000;
    const returnMatch = step.returnMatch || step.match || step.includes || '';
    const start = Date.now();
    const openerTabId = this.tab.id;
    let oauthTabId: number | null = null;

    while (Date.now() - start < Math.min(15000, timeout)) {
      const tabs = await chrome.tabs.query({});
      const child =
        tabs.find((t) => t.openerTabId === openerTabId && !beforeIds.has(t.id)) ||
        tabs.find(
          (t) =>
            !beforeIds.has(t.id) &&
            t.id !== openerTabId &&
            /oauth|authorize|accounts\.|login\./i.test(t.url || t.pendingUrl || '')
        );
      if (child) {
        oauthTabId = child.id!;
        break;
      }
      try {
        const main = await this.tab.get();
        if (/oauth|authorize|accounts\.|login\./i.test(main.url || '')) break;
      } catch {
        throw new TabGoneError('标签页已关闭');
      }
      await this.signal.sleep(400);
    }

    if (oauthTabId != null) {
      try {
        await chrome.tabs.update(oauthTabId, { active: true });
      } catch {
        /* ignore */
      }
      await setRuntime({ state: RUN_STATE.NEED_MANUAL, message: '请在 OAuth 标签页完成授权' });
      this.notify('自动执行 - OAuth 授权', '已打开授权页，完成后将自动继续', 2);

      while (Date.now() - start < timeout) {
        try {
          await chrome.tabs.get(oauthTabId);
        } catch {
          await this.signal.sleep(800);
          if (returnMatch) {
            try {
              await this.tab.waitUrl(returnMatch, 30000);
            } catch {
              /* 无 returnMatch 成功也可 */
            }
          }
          try {
            await chrome.tabs.update(openerTabId, { active: true });
          } catch {
            /* ignore */
          }
          return;
        }
        if (returnMatch) {
          try {
            const main = await this.tab.get();
            if (main.url && buildMatcher(returnMatch)(main.url)) {
              try {
                await chrome.tabs.remove(oauthTabId);
              } catch {
                /* ignore */
              }
              return;
            }
          } catch {
            /* ignore */
          }
        }
        await this.signal.sleep(800);
      }
      throw new Error('OAuth 弹窗授权超时');
    }

    if (returnMatch) {
      await this.tab.waitUrl(returnMatch, timeout - (Date.now() - start));
      return;
    }
    await this.waitManualAuth(
      {
        type: 'manual',
        message: '请完成 OAuth 授权，授权完成后回到业务页面',
        match: returnMatch,
        timeoutMs: timeout - (Date.now() - start),
      },
      timeout - (Date.now() - start)
    );
  }

  /** 等待点击产生的子标签页并接管后续步骤。 */
  private async waitForPopupTab(
    beforeIds: Set<number | undefined>,
    timeoutMs: number
  ): Promise<TabSession | null> {
    if (!this.tab) return null;
    const openerTabId = this.tab.id;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      if (this.signal.isAborted) throw new AbortedError();
      const tabs = await chrome.tabs.query({});
      const fresh = tabs.filter((tab) => tab.id != null && !beforeIds.has(tab.id) && tab.id !== openerTabId);
      const child = fresh.find((tab) => tab.openerTabId === openerTabId) || (fresh.length === 1 ? fresh[0] : null);
      if (child?.id != null) {
        const popup = TabSession.attach(child.id, this.signal);
        await popup.waitComplete(Math.max(1000, Math.min(45000, timeoutMs)), 600);
        return popup;
      }
      await this.signal.sleep(200);
    }
    return null;
  }

  private async executeUserScript(source: string, timeoutMs: number): Promise<UserScriptResult> {
    if (!this.tab) return { ok: false, message: '无标签页', needKeywordCheck: false };
    try {
      const result = await this.tab.inject(pageRunUserScript, [source, timeoutMs]);
      // 用户脚本可能无 return（undefined）：必须回退成结构化结果，
      // 否则调用方读 execResult.ok 会抛 TypeError，被当成执行失败/掉线。
      if (!result) {
        return { ok: false, message: '脚本无返回值', needKeywordCheck: false };
      }
      return result;
    } catch (e) {
      return {
        ok: false,
        message: (e as Error)?.message || String(e),
        needKeywordCheck: false,
      };
    }
  }

  private async executeVerificationAction(proc: VerificationProcedure): Promise<ExecutionResult> {
    if (!this.tab) return { ok: false, message: '无标签页可执行验证技能', needKeywordCheck: false };
    await setRuntime({
      state: RUN_STATE.NEED_MANUAL,
      message: `执行验证技能：${proc.name}`,
    });
    this.activeVerificationProc = proc;
    try {
      const timeout = proc.timeoutMs || 180000;
      if ((!proc.steps || proc.steps.length === 0) && proc.script) {
        return await this.executeUserScript(proc.script, timeout);
      }
      return await this.executeSteps(proc.steps || [], timeout, { label: '验证技能' });
    } finally {
      this.activeVerificationProc = null;
    }
  }

  private async isVerificationActionCleared(proc: VerificationProcedure): Promise<boolean> {
    if (!this.tab) return false;
    try {
      const tab = await this.tab.get();
      const hasConfiguredSignal = !!(
        proc.detect.completedUrlIncludes || proc.detect.completedSelector
      );
      if (proc.detect.completedUrlIncludes && tab.url?.includes(proc.detect.completedUrlIncludes)) {
        return true;
      }
      if (proc.detect.completedSelector) {
        const exists = await this.tab.inject(pageQueryExists, [proc.detect.completedSelector]);
        if (exists) return true;
      }
      // 用户显式配置了完成信号时，以该信号为准。否则某些未被通用规则
      // 识别的 OTP/自定义验证页会因为“不是 Cloudflare”而被误判为已完成。
      if (hasConfiguredSignal) return false;
      const detect = await this.tab.inject(detectChallengeInPage);
      const clearance = await hasCfClearance(tab.url || this.target.url);
      return isChallengeCleared(detect, clearance);
    } catch {
      return false;
    }
  }

  // —— CF 防护 ——

  private async waitForChallengeClear(
    url: string,
    timeoutMs: number
  ): Promise<{ ok: boolean; waited: number; message?: string }> {
    if (!this.tab) return { ok: false, waited: 0 };
    const start = Date.now();
    const grace = this.settings.cfManualGraceMs || 120000;
    let sawChallenge = false;
    let verificationActionUsed = false;
    let verificationActionError = '';

    while (Date.now() - start < timeoutMs) {
      if (this.signal.isAborted) throw new AbortedError();
      await this.tab.assertAlive();

      let detect;
      try {
        detect = await this.tab.inject(detectChallengeInPage);
      } catch {
        await this.signal.sleep(800);
        continue;
      }

      const clearance = await hasCfClearance(url);
      if (isChallengeCleared(detect, clearance)) {
        await this.signal.sleep(500);
        try {
          const again = await this.tab.inject(detectChallengeInPage);
          if (!again?.isChallenge) return { ok: true, waited: Date.now() - start };
        } catch {
          await this.tab.assertAlive();
        }
      }
      sawChallenge ||= !!detect?.isChallenge;
      const actionDelay = Math.min(5000, Math.max(0, timeoutMs));
      if (
        sawChallenge &&
        this.verificationProc &&
        !verificationActionUsed &&
        !this.activeVerificationProc &&
        Date.now() - start >= actionDelay
      ) {
        verificationActionUsed = true;
        const actionResult = await this.executeVerificationAction(this.verificationProc);
        if (actionResult.ok && await this.isVerificationActionCleared(this.verificationProc)) {
          return { ok: true, waited: Date.now() - start };
        }
        if (!actionResult.ok) verificationActionError = actionResult.message;
        await setRuntime({
          state: RUN_STATE.WAITING_CF,
          message: actionResult.ok
            ? `验证技能已完成，正在确认：${this.verificationProc.name}`
            : `验证技能未完成，等待人工处理：${this.verificationProc.name}`,
        });
      }
      await this.signal.sleep(1000);
    }

    await this.tab.focus().catch(() => {});
    await setRuntime({ state: RUN_STATE.NEED_MANUAL, message: '需要完成人机验证' });
    this.notify('自动执行 - 需要人机验证', '已打开标签页，请完成验证后将自动继续（宽限时间内）', 2);

    const graceStart = Date.now();
    while (Date.now() - graceStart < grace) {
      if (this.signal.isAborted) throw new AbortedError();
      await this.tab.assertAlive();
      let detect;
      try {
        detect = await this.tab.inject(detectChallengeInPage);
      } catch {
        await this.signal.sleep(1000);
        continue;
      }
      const clearance = await hasCfClearance(url);
      if (isChallengeCleared(detect, clearance)) {
        return { ok: true, waited: Date.now() - start };
      }
      await this.signal.sleep(1000);
    }

    return {
      ok: false,
      waited: Date.now() - start,
      message: '人机验证超时：请手动完成验证后重新执行',
      ...(verificationActionError ? { message: `验证技能失败：${verificationActionError}；人机验证仍未完成` } : {}),
    };
  }

  // —— 介入 ——

  private async awaitIntervention(
    ctx: Omit<InterventionContext, 'token'>
  ): Promise<InterventionDecision> {
    const token = newToken();
    await setRuntime({
      state: RUN_STATE.NEED_INTERVENTION,
      message: `步骤 ${ctx.stepIndex + 1} 执行失败，等待介入：${ctx.error || ''}`,
      intervention: {
        token,
        procId: ctx.procId || '',
        stepIndex: ctx.stepIndex,
        step: ctx.step || null,
        error: ctx.error || '',
      },
    });
    this.notify(
      '自动执行 - 需要介入',
      `步骤 ${ctx.stepIndex + 1} 失败：${ctx.error || ''}。请到设置页处理`,
      2
    );
    return new Promise<InterventionDecision>((resolve) => {
      pendingIntervention = { token, resolve };
    });
  }

  // —— 收尾 ——

  private async finalizeTab(status: RunStatus): Promise<void> {
    if (!this.tab) return;
    const shouldClose = this.standalone
      ? status === 'success' && !this.keepTab
      : status === 'success' || this.target.keepTabOnError === false;

    if (shouldClose) {
      await Promise.all(this.ownedTabs.map((tab) => tab.close()));
      this.tab = null;
      this.ownedTabs = [];
    } else if (status !== 'success') {
      await this.tab.focus();
    }
  }

  private async handleRunError(e: unknown): Promise<RunOutcome> {
    const msg = (e as Error)?.message || String(e);
    const tabGone = e instanceof TabGoneError;
    if (this.tab) {
      if (!tabGone && this.target.keepTabOnError !== false && !this.signal.isAborted) {
        await this.tab.focus();
      } else {
        await Promise.all(this.ownedTabs.map((tab) => tab.close()));
      }
      this.tab = null;
      this.ownedTabs = [];
    }
    return this.outcome(this.signal.isAborted ? 'skipped' : 'failed', msg);
  }
}

/**
 * 在独立标签页中直接执行一个 checkin 技能（画布「调用技能」节点 / 流程运行使用）。
 * 不绑定站点、不进队列；目标网址由 options.url / 首个 goto 步骤 / 绑定站点推导。
 */
export async function runProcedureStandalone(
  procedureId: string,
  options: { url?: string; keepTab?: boolean; active?: boolean; watchDeviation?: boolean } = {}
): Promise<RunOutcome & { ok: boolean; tabId?: number | null }> {
  if (isQueueRunning()) {
    throw new Error('当前有执行队列正在运行，请稍候或先停止');
  }
  const settings = await getSettings();
  const proc = await getProcedure(procedureId);
  if (!proc) throw new Error('找不到技能：' + procedureId);
  if (proc.kind === 'login') {
    throw new Error('登录技能不能独立运行，请在站点中配合自动化技能使用');
  }

  // 网址推导：节点显式填写 → 技能自身 url → 技能内首个 goto/waitForUrl 步骤 → 绑定站点网址
  let url = (options.url || proc.url || '').trim();
  if (!url && Array.isArray(proc.steps)) {
    const goto = proc.steps.find(
      (s) => s && (s.type === 'goto' || s.type === 'waitForUrl') && (s.url || s.selector)
    ) as { url?: string; selector?: string } | undefined;
    if (goto) url = String(goto.url || goto.selector || '').trim();
  }
  if (!url) {
    const allSites = await getSites();
    const bound = allSites.find((s) => s.id === proc.siteId && s.url)
      || allSites.find((s) => s.checkinProcedureId === proc.id && s.url);
    if (bound) url = bound.url;
  }
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error(`技能「${proc.name}」没有可用的目标网址，请在右侧节点属性中填写`);
  }

  const signal = new CancellationToken();
  const ctx = new RunContext({
    settings,
    checkinProc: proc,
    loginProc: null,
    signal,
    target: {
      url,
      name: proc.name,
      mode: proc.steps?.length === 0 && proc.script ? 'script' : 'steps',
      stepsTimeoutMs: 120000,
      pageLoadTimeoutMs: settings.defaultPageLoadTimeoutMs || 45000,
      cfTimeoutMs: settings.defaultCfTimeoutMs || 90000,
      keepTabOnError: true,
      openInBackground: false,
    },
    standalone: true,
    keepTab: options.keepTab === true,
    active: options.active,
    watchDeviation: options.watchDeviation === true,
  });

  const startedAt = Date.now();
  try {
    const outcome = await ctx.run();
    const ok = outcome.status === 'success';
    const message = outcome.message || (ok ? '执行成功' : '执行失败');
    await upsertProcedure({
      ...proc,
      lastResult: { status: ok ? 'success' : 'failed', message, at: Date.now() },
    });
    return { ...outcome, ok, message, startedAt, tabId: outcome.tabId };
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    return {
      ok: false,
      status: 'failed',
      message: msg,
      startedAt,
      finishedAt: Date.now(),
      cfWaitedMs: 0,
      tabId: null,
    };
  } finally {
    if (!isQueueRunning()) {
      await setRuntime({ state: RUN_STATE.IDLE, message: '空闲' });
    }
  }
}

// 前向引用：避免与 execution-queue 的循环依赖，运行时再取模块单例状态。
// 由 execution-queue 模块在初始化时通过 setQueueRunningHook 注入。
let queueRunningHook: () => boolean = () => false;
export function setQueueRunningHook(fn: () => boolean): void {
  queueRunningHook = fn;
}
function isQueueRunning(): boolean {
  return queueRunningHook();
}
