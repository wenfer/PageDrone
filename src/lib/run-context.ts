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
  updateSiteLastResult,
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
import {
  pageRunOneStep,
  pageSubmitAutofilledLogin,
  type AutofilledLoginResult,
  type PageStepResult,
} from './page/steps.js';
import { samplePageState, type PageState } from './page/explorer-sample.js';
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
  PageObservation,
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

/** 流程节点可通过 executionId 取消后台技能，避免 UI 超时后留下孤儿标签页。 */
const standaloneRuns = new Map<string, CancellationToken>();

export function abortStandaloneRun(executionId: string): boolean {
  const token = standaloneRuns.get(executionId);
  if (!token) return false;
  token.abort();
  return true;
}

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
  /** 诊断模式下每个步骤前后采样页面，并把事实回流给调用方。 */
  diagnostic?: boolean;
  onObservation?: (observation: PageObservation) => void | Promise<void>;
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
  private readonly diagnostic: boolean;
  private readonly onObservation?: (observation: PageObservation) => void | Promise<void>;

  private tab: TabSession | null = null;
  /** 本次运行创建或接管的全部标签页；跨标签技能成功收尾时一并清理。 */
  private ownedTabs: TabSession[] = [];
  private cfWaitedMs = 0;
  private activeVerificationProc: VerificationProcedure | null = null;
  private readonly startedAt: number;
  private previousPageState: PageState | null = null;
  private observations: PageObservation[] = [];
  /** 当前是否正在执行站点绑定的登录技能，用于让通用人工步骤读取登录态信号。 */
  private runningLoginProc = false;

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
    this.diagnostic = !!opts.diagnostic;
    this.onObservation = opts.onObservation;
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
      await this.observePage('initial', -1, { type: 'open' });

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
    } finally {
      // 诊断运行是只读旁路。无论是防护/登录提前返回，还是执行阶段抛错，
      // 都要关闭测试创建的标签页，避免测试失败时把隔离页遗留在用户工作区。
      if (this.diagnostic && this.tab) {
        await Promise.all(this.ownedTabs.map((tab) => tab.close()));
        this.tab = null;
        this.ownedTabs = [];
      }
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
      ...(execResult?.failedStepIndex !== undefined ? { failedStepIndex: execResult.failedStepIndex } : {}),
      ...(execResult?.failedStepType ? { failedStepType: execResult.failedStepType } : {}),
      ...(this.observations.length ? { observations: [...this.observations] } : {}),
    };
  }

  /**
   * 诊断模式的页面事实采样。采样失败不能改变原技能执行结果；页面可能正在导航，
   * 下一次采样会继续尝试。密码输入框不把实际值回传给 AI。
   */
  private async observePage(
    phase: PageObservation['phase'],
    stepIndex: number,
    step: { type: string },
  ): Promise<void> {
    if (!this.diagnostic || !this.tab) return;
    try {
      const state = await this.tab.inject(samplePageState, []);
      if (!state) return;
      const elements = (state.elements || []).slice(0, 40).map((element) => ({
        ...element,
        text: element.type.toLowerCase() === 'password' ? '[密码字段]' : element.text,
      }));
      const previous = this.previousPageState;
      const changes: string[] = [];
      if (!previous) changes.push('首次读取页面');
      else {
        if (previous.url !== state.url) changes.push(`URL 从 ${previous.url} 变为 ${state.url}`);
        if (previous.title !== state.title) changes.push('页面标题发生变化');
        if (previous.text !== state.text) changes.push('页面正文发生变化');
        if (previous.elements.length !== state.elements.length) changes.push('可交互元素数量发生变化');
      }
      const observation: PageObservation = {
        at: Date.now(),
        phase,
        stepIndex,
        stepType: step.type,
        tabId: this.tab.id,
        url: state.url,
        title: state.title,
        text: String(state.text || '').slice(0, 1800),
        elements,
        changed: changes.length > 0,
        changes,
      };
      this.previousPageState = { ...state, elements };
      this.observations.push(observation);
      if (this.observations.length > 80) this.observations.shift();
      await this.onObservation?.(observation);
    } catch {
      // 观察只是诊断旁路，不能把导航瞬间的注入失败误判成技能失败。
    }
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
    const hasPositiveSignal = Boolean(
      detect.loggedInSelector?.trim() || detect.loggedInUrlIncludes?.trim()
    );
    // 开始前只有在页面确实像登录页时才执行登录技能。即使历史技能错误地把
    // “登录入口”填进了已登录选择器，只要当前页面没有登录表单/登录 URL/未登录
    // 关键词，也不要把已经登录的用户再次拦截到登录流程。
    if (reason === 'precheck') {
      const explicitlyLoggedOut = await this.isLikelyLoginPage(detect);
      if (!explicitlyLoggedOut) return { ok: true, message: '', cfWaitedMs: 0 };
    }
    if (hasPositiveSignal && await this.isLoggedInProc(detect)) {
      return { ok: true, message: '', cfWaitedMs: 0 };
    }

    const reasonLabel =
      ({
        precheck: '开始前检查',
        step_failed: '操作步骤失败',
        keyword: '命中未登录关键词',
        url_redirect: '跳转到登录页',
      } as Record<string, string>)[reason] || reason;

    await setRuntime({
      state: RUN_STATE.RUNNING,
      message: `自动登录（${reasonLabel}）：${this.loginProc.name || ''}`,
    });

    const loginTimeout = this.loginProc.timeoutMs || 180000;
    let loginResult: ExecutionResult;
    this.runningLoginProc = true;
    try {
      loginResult = await this.executeSteps(this.loginProc.steps || [], loginTimeout, {
        label: '登录',
      });
    } finally {
      this.runningLoginProc = false;
    }
    if (!loginResult.ok) {
      return {
        ok: false,
        status: 'need_login',
        message: `自动登录失败（${reasonLabel}）：${loginResult.message || '未完成'}`,
      };
    }

    // 登录技能可以只包含点击/等待入口，不需要把 manual 写入配置。入口展开后
    // 轮询提交 Chrome 已自动填充的普通表单；密码内容只在目标页面内用于判断
    // 是否非空，不会被扩展读取、保存或回传。
    const autofill = await this.trySubmitAutofilledLogin(Math.min(loginTimeout, 8000));
    if (autofill?.submitted) {
      const settled = await this.waitForAutofilledLoginCompletion(
        detect,
        Math.min(loginTimeout, 30000),
      );
      if (!settled) {
        return {
          ok: false,
          status: 'need_login',
          message: `已提交自动填充的登录表单，但未确认登录完成（${reasonLabel}）`,
        };
      }
    }

    const stillLoginPage = await this.isLikelyLoginPage(detect);
    const after = hasPositiveSignal
      ? (await this.isLoggedInProc(detect)) || !stillLoginPage
      : !stillLoginPage;
    if (!after && hasPositiveSignal) {
      return {
        ok: false,
        status: 'need_login',
        message: `登录步骤已完成但仍未检测到登录态（${reasonLabel}）`,
      };
    }
    if (!after && !hasPositiveSignal) {
      return {
        ok: false,
        status: 'need_login',
        message: autofill?.hasPasswordField
          ? '检测到普通登录表单，但没有确认登录完成；请在站点页面完成登录后重新测试'
          : '未检测到登录完成信号；请在站点页面完成登录后重新测试',
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

  /** 在登录入口点击后给自动填充留出短暂时间，避免表单异步渲染导致漏提交流程。 */
  private async trySubmitAutofilledLogin(timeoutMs: number): Promise<AutofilledLoginResult | null> {
    if (!this.tab) return null;
    const end = Date.now() + Math.max(1000, timeoutMs);
    let last: AutofilledLoginResult | null = null;
    while (Date.now() < end) {
      try {
        last = await this.tab.inject(pageSubmitAutofilledLogin, []);
        if (last?.submitted) return last;
        // 表单已出现但没有提交入口时继续等待没有意义；让调用方给出明确提示。
        if (last?.hasPasswordField && last.credentialsReady) return last;
      } catch {
        /* 页面正在导航，下一轮重试 */
      }
      await this.signal.sleep(400);
    }
    return last;
  }

  /** 等待提交后的登录态变化；优先使用用户配置的已登录信号，否则观察表单消失。 */
  private async waitForAutofilledLoginCompletion(
    detect: Partial<LoginDetect>,
    timeoutMs: number,
  ): Promise<boolean> {
    const end = Date.now() + Math.max(2000, timeoutMs);
    let noFormHits = 0;
    while (Date.now() < end) {
      if (detect.loggedInSelector || detect.loggedInUrlIncludes) {
        if (await this.isLoggedInProc(detect)) return true;
      }
      const hasForm = await this.hasOrdinaryLoginForm();
      if (!hasForm) {
        noFormHits += 1;
        if (noFormHits >= 2) return true;
      } else {
        noFormHits = 0;
      }
      await this.signal.sleep(700);
    }
    return false;
  }

  /** AI 过去生成的“请用户手动登录”步骤属于泛化兜底，不应阻塞普通表单自动登录。 */
  private isGenericLoginManualStep(step: Step): boolean {
    if (!this.runningLoginProc || step.type !== 'manual') return false;
    if (step.match || step.includes || step.url || step.selector) return false;
    return !/(oauth|授权|验证码|captcha|二次验证|双重验证|安全验证|人工确认|challenge)/i.test(step.message || '');
  }

  /**
   * 仅根据页面结构判断是否出现普通账号密码登录表单。
   * 页面采样器已从源头遮盖密码字段 value，这里只消费字段类型和按钮文案。
   */
  private async hasOrdinaryLoginForm(): Promise<boolean> {
    if (!this.tab) return false;
    try {
      const state = await this.tab.inject(samplePageState, []);
      const elements = state?.elements || [];
      const hasPassword = elements.some((element) => element.type.toLowerCase() === 'password');
      if (!hasPassword) return false;
      return elements.some((element) => {
        const type = element.type.toLowerCase();
        return type === 'submit' || /登录|登錄|sign\s*in|log\s*in|submit/i.test(element.text || '');
      });
    } catch {
      return false;
    }
  }

  /** 明确的登录页事实：配置 URL/关键词、通用登录 URL 或普通登录表单。 */
  private async isLikelyLoginPage(detect: Partial<LoginDetect>): Promise<boolean> {
    if (!this.tab) return false;
    try {
      const url = await this.tab.url;
      if (detect.loginUrlPattern && buildMatcher(detect.loginUrlPattern)(url)) return true;
      if (/(?:^|[/:._-])(login|signin|sign-in|authentication|auth)(?:[/?#._-]|$)/i.test(url)) return true;
    } catch {
      /* 页面正在导航，交给表单检测 */
    }
    if (await this.hasOrdinaryLoginForm()) return true;
    const keywords = detect.notLoggedInKeywords || [];
    if (!keywords.length) return false;
    const text = await this.tab.getText();
    return Boolean(text && keywords.some((keyword) => keyword && text.includes(keyword)));
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
    const hasFailureContext = Boolean(errMessage && errMessage.trim());
    if (hasFailureContext && /登录|未登录|please\s*sign?\s*in|login\s*required/i.test(errMessage)) {
      return true;
    }
    // 成功完成步骤时不要仅因页面导航/页脚里出现“请登录”就触发重登。
    // 关键词检测用于失败后的兜底；明确的登录页 URL 仍然不受此限制。
    if (hasFailureContext) {
      const kws = detect.notLoggedInKeywords || [];
      if (kws.length) {
        const text = await this.tab.getText();
        if (text && kws.some((k) => k && text.includes(k))) return true;
      }
      if (this.checkinProc.kind === 'checkin') {
        const failKws = this.checkinProc.detect.failKeywords || [];
        if (failKws.some((k) => /登录|login/i.test(k) && errMessage.includes(k))) {
          return true;
        }
      }
    }
    // 许多站点的登录失效只表现为跳转到表单页，步骤错误信息本身不含“登录”。
    // 可见密码字段 + 提交入口是比正文关键词更可靠的登录态信号，也支持无配置
    // loginUrlPattern 的普通表单站点；仅在当前执行已有登录技能时启用。
    if (await this.hasOrdinaryLoginForm()) return true;
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
      await this.observePage('before', -1, { type: 'script' });
      const result = await this.executeUserScript(this.checkinProc.script || '', 60000);
      await this.observePage(result.ok ? 'after' : 'error', -1, { type: 'script' });
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
        await this.observePage('before', i, step);

        if (onDeviation) {
          let done = false;
          while (!done) {
            if (Date.now() > deadline) throw new Error(`${label}总超时`);
            try {
              const output = await this.runOneStep(step, deadline, i);
              if (output) outputs[output.name] = output.value;
              await this.observePage('after', i, step);
              done = true;
            } catch (stepErr) {
              // 登录跳转和取消也保留一次失败前页面快照，方便诊断工具说明真实原因；
              // 只有在快照完成后才决定是否进入重登/介入分支。
              await this.observePage('error', i, step);
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
          try {
            const output = await this.runOneStep(step, deadline, i);
            if (output) outputs[output.name] = output.value;
            await this.observePage('after', i, step);
          } catch (stepErr) {
            await this.observePage('error', i, step);
            throw stepErr;
          }
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
        ...(this.observations.length
          ? (() => {
              const failed = [...this.observations].reverse().find((observation) => observation.phase === 'error');
              return failed
                ? { failedStepIndex: failed.stepIndex, failedStepType: failed.stepType }
                : {};
            })()
          : {}),
      };
    }
  }

  private async runOneStep(step: Step, deadline: number, stepIndex = 0): Promise<StepOutput | null> {
    const remain = () => Math.max(1000, (deadline || Date.now() + 60000) - Date.now());

    if (step.type === 'wait') {
      const waitMs = Number(step.ms) || 1000;
      const end = Date.now() + Math.max(0, waitMs);
      while (Date.now() < end) {
        await this.signal.sleep(Math.min(1000, end - Date.now()));
        await this.observePage('after', stepIndex, step);
      }
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
      if (this.isGenericLoginManualStep(step)) {
        const autofill = await this.trySubmitAutofilledLogin(Math.min(remain(), 8000));
        if (!autofill?.submitted) {
          throw new Error('登录技能不能依赖人工操作；未检测到可提交的 Chrome 自动填充表单');
        }
        if (!await this.waitForAutofilledLoginCompletion(this.loginProc?.detect || {}, Math.min(remain(), 30000))) {
          throw new Error('已提交自动填充的登录表单，但未确认登录完成');
        }
        return null;
      }
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
    const message = step.message || '请完成当前页面要求的登录或其他人工操作';
    const match = step.match || step.includes || step.url || '';
    const selector = step.selector || '';

    await this.tab.focus();
    await setRuntime({ state: RUN_STATE.NEED_MANUAL, message });
    this.notify(
      '自动执行 - 需要人工完成登录',
      message + (match ? `（完成后等待 URL 含：${match}）` : ''),
      2
    );

    const start = Date.now();
    const tester = match ? buildMatcher(match) : null;
    let stableHits = 0;
    let lastUrl = '';
    let initialUrl = '';
    let urlChanged = false;
    let autoSubmitAttempted = false;
    let submittedFormGoneHits = 0;
    while (Date.now() - start < timeout) {
      let url: string;
      try {
        const tab = await this.tab.get();
        url = tab.url || '';
        if (!initialUrl) initialUrl = url;
        if (initialUrl && url && url !== initialUrl) urlChanged = true;
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
        if (
          this.runningLoginProc &&
          !tester &&
          !selector &&
          (this.loginProc?.detect.loggedInSelector || this.loginProc?.detect.loggedInUrlIncludes) &&
          await this.isLoggedInProc(this.loginProc.detect)
        ) {
          return;
        }
        if (this.runningLoginProc && !tester && !selector) {
          try {
            const autofill = await this.tab.inject(pageSubmitAutofilledLogin, []);
            if (autofill?.submitted) {
              autoSubmitAttempted = true;
              await setRuntime({
                state: RUN_STATE.NEED_MANUAL,
                message: '已提交 Chrome 自动填充的登录表单，等待登录完成',
              });
            } else if (autoSubmitAttempted && autofill && !autofill.hasPasswordField) {
              submittedFormGoneHits += 1;
              if (submittedFormGoneHits >= 3) return;
            } else if (!autofill?.submitted) {
              submittedFormGoneHits = 0;
            }
          } catch {
            /* 页面跳转或受限页，继续用 URL/选择器判断登录完成 */
          }
        }
        // 无匹配条件时只能把“发生了导航并稳定下来”作为完成信号，
        // 不能因普通登录页 URL 一直不变就自动结束人工操作。
        if (!tester && !selector && urlChanged && Date.now() - start > 3000) {
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
    throw new Error(`人工登录操作超时：${message}`);
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
      await setRuntime({ state: RUN_STATE.NEED_MANUAL, message: '请在弹窗页面完成登录或授权' });
      this.notify('自动执行 - 需要完成弹窗登录或授权', '已打开弹窗页面，完成后将自动继续', 2);

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
      throw new Error('弹窗登录或授权超时');
    }

    if (returnMatch) {
      await this.tab.waitUrl(returnMatch, timeout - (Date.now() - start));
      return;
    }
    // 旧版/误配置的登录技能可能遗留 watchPopup=true，但普通表单通常在原标签页
    // 展开。确认当前 URL 不是 OAuth/授权域后，切回通用人工登录等待；该等待会
    // 尝试提交 Chrome 自动填充的账号密码，不再把普通表单报成 OAuth 超时。
    try {
      const currentUrl = await this.tab.url;
      const oauthUrl = /oauth|authorize|accounts\.|login\.microsoftonline|sso\.|auth0\.com|okta\.com/i.test(currentUrl);
      if (this.runningLoginProc && !oauthUrl && await this.hasOrdinaryLoginForm()) {
        await this.waitManualAuth(
          {
            type: 'manual',
            message: '请完成普通账号密码登录；Chrome 可自动填充已保存的账号密码，扩展不会读取密码',
            match: '',
            timeoutMs: timeout - (Date.now() - start),
          },
          timeout - (Date.now() - start)
        );
        return;
      }
    } catch {
      /* 页面跳转中，下面仍按显式弹窗流程等待 */
    }
    await this.waitManualAuth(
      {
        type: 'manual',
        message: '请完成弹窗登录或授权，完成后回到业务页面',
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
        await this.observePage('before', -1, { type: 'verification-script' });
        const result = await this.executeUserScript(proc.script, timeout);
        await this.observePage(result.ok ? 'after' : 'error', -1, { type: 'verification-script' });
        return result;
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
      await this.observePage('after', -1, { type: 'challenge' });

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
      await this.observePage('after', -1, { type: 'challenge' });
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
    const shouldClose = this.diagnostic
      ? true
      : this.standalone
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
      if (!tabGone && !this.diagnostic && this.target.keepTabOnError !== false && !this.signal.isAborted) {
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
  options: {
    url?: string;
    keepTab?: boolean;
    active?: boolean;
    watchDeviation?: boolean;
    diagnostic?: boolean;
    onObservation?: (observation: PageObservation) => void | Promise<void>;
    withSiteLogin?: boolean;
    executionId?: string;
  } = {}
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
  if (options.executionId) standaloneRuns.set(options.executionId, signal);
  let loginProc: LoginProcedure | null = null;
  if (options.withSiteLogin && proc.siteId) {
    const owner = (await getSites()).find((site) => site.id === proc.siteId);
    if (owner?.loginProcedureId) {
      const candidate = await getProcedure(owner.loginProcedureId);
      if (candidate?.kind === 'login') loginProc = candidate;
    }
  }
  const ctx = new RunContext({
    settings,
    checkinProc: proc,
    loginProc,
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
    diagnostic: options.diagnostic === true,
    onObservation: options.onObservation,
  });

  const startedAt = Date.now();
  try {
    const outcome = await ctx.run();
    const ok = outcome.status === 'success';
    const message = outcome.message || (ok ? '执行成功' : '执行失败');
    // AI 诊断必须保持只读：测试报告从 RunOutcome 返回，不要把“最后结果”写回技能，
    // 否则仅仅查看/测试也会触发 storage 变更并污染用户的执行历史。
    if (!options.diagnostic) {
      await upsertProcedure({
        ...proc,
        lastResult: { status: ok ? 'success' : 'failed', message, at: Date.now() },
      });
    }
    // 独立运行技能（设置页或流程节点）同样要把登录失效回写到所属网站，
    // 让用户不必等到整站队列运行后才看到“需要登录”提示。成功后同步清除旧提示。
    if (proc.siteId && (!options.diagnostic || outcome.status === 'success' || outcome.status === 'need_login')) {
      await updateSiteLastResult(proc.siteId, {
        status: outcome.status,
        message,
        at: Date.now(),
        ...(outcome.cfWaitedMs ? { cfWaitedMs: outcome.cfWaitedMs } : {}),
      });
    }
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
    if (options.executionId) standaloneRuns.delete(options.executionId);
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
