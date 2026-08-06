/**
 * 探索归纳引擎（Exploration & Induction Engine）
 *
 * 专利核心发明点第一阶段：LLM 驱动浏览器自主探索目标网站，
 * 观察页面状态 → 决策下一步操作 → 执行 → 再观察，直到命中目标；
 * 把成功路径「固化」为一串确定性步骤（steps[]），供后续无 LLM 的快速执行使用。
 */

import { setRuntime } from './storage.js';
import { RUN_STATE } from './messaging.js';
import { CancellationToken } from './cancellation.js';
import { TabSession } from './tab-session.js';
import { samplePageState, type PageState } from './page/explorer-sample.js';
import { execPageAction } from './page/explorer-exec.js';
import { pageExtractData, type PageExtractResult } from './page/extract.js';
import { LlmClient } from './llm.js';
import type { ExtractMode, Settings, Step } from './models.js';
import type {
  ExploreActionTrace,
  ExploreProgress,
  ExploreProgressEvent,
  ExploreProgressStage,
  ExploreProgressStatus,
} from './types.js';

const DEFAULT_MAX_STEPS = 15;
const DEFAULT_STEP_TIMEOUT = 15000;
const EXTRACT_MODES: ExtractMode[] = ['text', 'attribute', 'html', 'value', 'list', 'table'];

interface LLMAction {
  action: string;
  args?: Record<string, string>;
  reason?: string;
}

interface ActionObservation {
  urlBefore: string;
  urlAfter: string;
  urlChanged: boolean;
  titleChanged: boolean;
  textChanged: boolean;
  interactiveElementsChanged: boolean;
  changed: boolean;
}

interface ActionExecutionResult {
  ok: boolean;
  /** confirmed 表示操作有可核验的页面或执行证据；ok 只表示操作已被浏览器接受。 */
  confirmed: boolean;
  message: string;
  evidence?: unknown;
  /** 点击后检测到并接管的新标签页。 */
  openedTabId?: number;
  openedNewTab?: boolean;
  observation: ActionObservation;
}

interface ExplorationTranscriptEntry {
  step: number;
  kind: string;
  [key: string]: unknown;
}

export class ExplorationResult {
  constructor(
    readonly ok: boolean,
    readonly steps: Step[],
    readonly message: string,
    readonly explorationId: string,
    readonly transcript: ExplorationTranscriptEntry[]
  ) {}
}

const SYSTEM_PROMPT = `你是一个网页自动化专家，负责通过一步步操作浏览器来完成给定目标。
每一轮我会给你当前页面的状态（URL、标题、正文片段、可交互元素列表及其选择器）。
你只需输出「下一步」要执行的一个操作，用 JSON 对象表示，不要输出任何解释性文字。

重要：最终会把成功路径固化为技能的标准化动作序列，后续执行不再调用大模型。
因此只能使用下面列出的标准浏览器动作，禁止输出 JavaScript、脚本片段、伪造的 script 动作或把多个动作塞进一个动作中。
如果目标需要的行为无法由这些标准动作表达，请输出 fail，不能用脚本“补救”。

可用操作：
- {"action":"click","args":{"selector":"CSS或XPath"},"reason":"简述"}
- {"action":"type","args":{"selector":"CSS或XPath","text":"要输入的内容"},"reason":"简述"}
- {"action":"goto","args":{"url":"完整网址"},"reason":"简述"}
- {"action":"wait","args":{"ms":"等待毫秒数"},"reason":"简述"}
- {"action":"waitFor","args":{"selector":"CSS或XPath"},"reason":"简述"}
- {"action":"waitForText","args":{"selector":"body","includes":"页面上应出现的文字"},"reason":"简述"}
- {"action":"waitForUrl","args":{"match":"URL 子串或 /正则/"},"reason":"简述"}
- {"action":"extract","args":{"selector":"CSS或XPath","mode":"text|attribute|html|value|list|table","attribute":"属性名（仅 attribute 模式）","variable":"结果变量名","multiple":"true 或 false"},"reason":"简述"}
- {"action":"done","args":{},"reason":"目标已达成"}
- {"action":"fail","args":{},"reason":"无法达成目标的原因"}

要求：
1. 每次只输出一个 JSON 对象。
2. selector 优先使用元素列表里给出的 selector 值。
3. 目标达成（命中成功条件）时立即输出 done。
4. 若页面明显无法完成目标，输出 fail。
5. 每轮会提供上一步操作的结构化响应。ok=true 只表示浏览器接受了操作；只有 confirmed=true 才表示操作有可核验结果。confirmed=false 时不得声称操作已完成，应结合当前页面调整策略或等待。
6. extract 是标准化数据提取动作，必须使用页面状态中真实存在的 selector；不要把提取改写成脚本。提取动作只在元素确实存在时固化。
7. 如果响应中 openedNewTab=true，后续当前页面状态就是新标签页，请直接基于新页面继续决策。`;

export class ExplorationSession {
  private readonly url: string;
  private readonly goal: string;
  private readonly successKws: string[];
  private readonly settings: Settings;
  private readonly signal: CancellationToken;
  private readonly maxSteps: number;
  private readonly explorationId: string;

  private generatedSteps: Step[] = [];
  private transcript: ExplorationTranscriptEntry[] = [];
  private progressEvents: ExploreProgressEvent[] = [];
  private progressSequence = 0;
  private tab: TabSession | null = null;

  constructor(
    url: string,
    goal: string,
    successKws: string[],
    settings: Settings,
    private readonly onProgress: (progress: ExploreProgress) => void = () => {}
  ) {
    this.url = url;
    this.goal = goal;
    this.successKws = successKws;
    this.settings = settings;
    this.signal = new CancellationToken();
    this.maxSteps = settings.agentMaxSteps || DEFAULT_MAX_STEPS;
    this.explorationId = `exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  abort(): void {
    this.signal.abort();
  }

  async run(): Promise<ExplorationResult> {
    try {
      this.emitProgress(0, 'opening', 'running', '正在打开目标页面', { message: this.url, url: this.url });
      this.tab = await TabSession.create({ url: this.url, active: true }, this.signal);
      await setRuntime({ state: RUN_STATE.EXPLORING, message: `AI 探索中：${this.goal}` });
      await this.tab.waitComplete(this.settings.defaultPageLoadTimeoutMs || 45000, 600);
      this.emitProgress(0, 'opening', 'success', '目标页面已打开', { message: '页面加载完成，准备读取页面状态', url: this.url });

      for (let step = 1; step <= this.maxSteps; step++) {
        if (this.signal.isAborted) {
          return this.result(false, '探索已被用户取消');
        }

        this.emitProgress(step, 'observing', 'running', `第 ${step} 轮：读取页面状态`);
        const state = await this.readPage();
        if (!state) return this.result(false, '无法读取页面状态');
        this.emitProgress(step, 'observing', state.error ? 'warning' : 'success', state.error ? '页面状态读取不完整' : '页面状态已读取', {
          message: state.error || `标题“${state.title || '无标题'}”，发现 ${state.elements.length} 个可交互元素`,
          url: state.url,
        });

        if (this.successKws.length && this.successKws.some((k) => k && state.text.includes(k))) {
          this.emitProgress(step, 'complete', 'success', '命中成功关键词', { message: '页面事实满足用户配置的成功条件', url: state.url });
          this.transcript.push({ step, kind: 'converged', url: state.url });
          return this.result(true, `探索成功：命中成功关键词，共归纳 ${this.generatedSteps.length} 个步骤`);
        }

        const userPrompt = this.buildUserPrompt(state, step);
        this.emitProgress(step, 'thinking', 'running', `第 ${step} 轮：AI 正在分析页面`, { message: '根据页面状态和上一步浏览器响应决定下一操作', url: state.url });

        // LLM 调用 / 解析失败时，保留已归纳的步骤与 transcript 作为部分成果返回
        // （旧实现行为）；不能让异常直接抛出，否则 SW 的 catch 只拿到 message，
        // 丢掉 steps 计数与探索记录。
        let raw: string;
        try {
          raw = await this.callLLM(userPrompt);
        } catch (e) {
          return this.result(false, `调用大模型失败：${(e as Error)?.message || e}`);
        }

        let action: LLMAction;
        try {
          action = this.parseAction(raw);
        } catch (e) {
          return this.result(false, (e as Error)?.message || String(e));
        }

        this.transcript.push({ step, kind: 'decide', action, url: state.url });
        const actionTrace = this.actionTrace(action);
        this.emitProgress(step, 'decision', 'info', 'AI 已给出下一步决策', {
          message: action.reason || this.describeAction(action),
          action: actionTrace,
          url: state.url,
        });

        if (action.action === 'done') {
          return this.result(true, `探索完成：${action.reason || '目标达成'}，共归纳 ${this.generatedSteps.length} 个步骤`);
        }
        if (action.action === 'fail') {
          return this.result(false, `模型判定无法完成：${action.reason || ''}`);
        }

        this.emitProgress(step, 'executing', 'running', `正在执行：${this.describeAction(action)}`, {
          message: '操作已交给浏览器，等待页面执行函数返回事实响应',
          action: actionTrace,
          url: state.url,
        });
        const res = await this.execAction(action, state);
        const induction = this.induceStep(action, res);
        if (induction === 'added') {
          res.message += '；已加入最终技能步骤';
        } else if (induction === 'duplicate') {
          res.message += '；与上一有效步骤重复，未重复加入技能';
        } else if (induction === 'unconfirmed') {
          res.message += '；结果未经页面确认，未加入最终技能';
        }
        this.transcript.push({ step, kind: 'exec', action: action.action, result: res, induction });
        const responseStatus: ExploreProgressStatus = !res.ok ? 'error' : res.confirmed ? 'success' : 'warning';
        const responseTitle = !res.ok ? '浏览器返回：执行失败' : res.confirmed ? '浏览器返回：结果已确认' : '浏览器返回：操作已派发，结果未确认';
        this.emitProgress(step, 'response', responseStatus, responseTitle, {
          message: res.message || (res.ok ? '操作已触发' : '执行失败'),
          action: actionTrace,
          response: res,
          url: res.observation.urlAfter || state.url,
        });
      }

      return this.result(
        this.generatedSteps.length > 0,
        this.generatedSteps.length
          ? `达到探索步数上限，已归纳 ${this.generatedSteps.length} 个步骤（未确认命中成功关键词，请人工核对）`
          : '达到探索步数上限，未能生成有效步骤'
      );
    } catch (error) {
      const message = this.signal.isAborted ? '探索已被用户取消' : `探索异常：${(error as Error)?.message || String(error)}`;
      return this.result(false, message);
    } finally {
      await setRuntime({ state: RUN_STATE.IDLE, message: '空闲' });
    }
  }

  private emitProgress(
    step: number,
    stage: ExploreProgressStage,
    status: ExploreProgressStatus,
    title: string,
    detail: { message?: string; action?: ExploreActionTrace; response?: ActionExecutionResult; url?: string } = {}
  ): void {
    const at = Date.now();
    const event: ExploreProgressEvent = {
      id: `${this.explorationId}_${++this.progressSequence}`,
      step,
      stage,
      status,
      title,
      at,
    };
    if (detail.message !== undefined) event.message = detail.message;
    if (detail.action !== undefined) event.action = detail.action;
    if (detail.response !== undefined) event.response = detail.response;
    if (detail.url !== undefined) event.url = detail.url;
    this.progressEvents.push(event);
    const progress: ExploreProgress = {
      explorationId: this.explorationId,
      step,
      total: this.maxSteps,
      stage,
      message: detail.message || title,
      events: this.progressEvents.slice(-120),
      at,
    };
    if (detail.action?.label) progress.action = detail.action.label;
    if (detail.action?.reason) progress.reason = detail.action.reason;
    if (detail.url !== undefined) progress.url = detail.url;
    this.onProgress(progress);
  }

  private result(ok: boolean, message: string): ExplorationResult {
    const last = this.progressEvents[this.progressEvents.length - 1];
    if (!last || (last.stage !== 'complete' && last.stage !== 'error')) {
      this.emitProgress(last?.step || 0, ok ? 'complete' : 'error', ok ? 'success' : 'error', ok ? '探索完成' : '探索结束', { message, url: last?.url });
    }
    return new ExplorationResult(ok, this.generatedSteps, message, this.explorationId, this.transcript);
  }

  private actionTrace(action: LLMAction): ExploreActionTrace {
    const trace: ExploreActionTrace = {
      name: action.action,
      label: this.describeAction(action),
      args: { ...(action.args || {}) },
    };
    if (action.reason) trace.reason = action.reason;
    return trace;
  }

  private describeAction(action: LLMAction): string {
    const args = action.args || {};
    switch (action.action) {
      case 'click':
        return `点击 ${args.selector || '（缺少 selector）'}`;
      case 'type':
        return `向 ${args.selector || '（缺少 selector）'} 输入内容`;
      case 'goto':
        return `跳转 ${args.url || '（缺少 url）'}`;
      case 'wait':
        return `等待 ${args.ms || '1000'} 毫秒`;
      case 'waitFor':
        return `等待元素 ${args.selector || '（缺少 selector）'}`;
      case 'waitForText':
        return `等待文字 ${args.includes || '（缺少 includes）'}`;
      case 'waitForUrl':
        return `等待 URL ${args.match || args.includes || '（缺少 match）'}`;
      case 'extract':
        return `提取 ${args.selector || '（缺少 selector）'}${args.variable ? ` → ${args.variable}` : ''}`;
      default:
        return action.action;
    }
  }

  private async readPage(): Promise<PageState> {
    if (!this.tab) return { url: '', title: '', text: '', elements: [] };
    try {
      // 注入可能成功但无返回值（跳转中途、受限页边缘情况）：
      // 回退成空页面状态让 LLM 继续决策，而不是 undefined 终止整轮探索。
      const result = await this.tab.inject(samplePageState);
      return result || { url: '', title: '', text: '', elements: [], error: 'empty result' };
    } catch {
      return { url: '', title: '', text: '', elements: [], error: 'inject failed' };
    }
  }

  private buildUserPrompt(state: PageState, step: number): string {
    const els = (state.elements || [])
      .map(
        (e, i) =>
          `  ${i + 1}. <${e.tag}${e.type ? ' type=' + e.type : ''}> 文本:"${e.text}" selector: ${e.selector}`
      )
      .join('\n');
    const previousExec = [...this.transcript]
      .reverse()
      .find((entry) => entry.kind === 'exec');
    const previousResult = previousExec
      ? `\n上一步操作响应（浏览器返回的事实）：${JSON.stringify(previousExec.result)}\n必须依据该响应判断：ok=false 表示执行失败；ok=true 且 confirmed=false 表示操作已派发但页面没有可观察变化，不能宣称目标完成。失败或未确认时不要原样重复无效操作。\n`
      : '';
    return `目标：${this.goal}
成功条件（页面出现以下任一文字即算成功）：${this.successKws.length ? this.successKws.join(' / ') : '（未指定，请根据目标判断）'}
当前进度：第 ${step}/${this.maxSteps} 步
${previousResult}

当前页面状态：
URL: ${state.url}
标题: ${state.title}
正文片段:
${(state.text || '').slice(0, 800)}

可交互元素：
${els || '（未发现可交互元素）'}

请输出下一步操作的 JSON。`;
  }

  private async callLLM(userPrompt: string): Promise<string> {
    // 端点 / 鉴权头 / 自定义头的合并规则与设置页的「发消息测试」完全一致，
    // 设置页测通即代表探索这边也能跑通。
    const client = new LlmClient({
      provider: this.settings.llmProvider || 'anthropic',
      apiKey: this.settings.llmApiKey || '',
      baseUrl: this.settings.llmBaseUrl,
      model: this.settings.llmModel,
      headers: this.settings.llmHeaders,
    });
    return client.chat({ system: SYSTEM_PROMPT, user: userPrompt, maxTokens: 512, temperature: 0 });
  }

  private parseAction(text: string): LLMAction {
    if (!text) throw new Error('模型无输出');
    let s = text
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim();
    try {
      return JSON.parse(s) as LLMAction;
    } catch {
      /* continue */
    }
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1)) as LLMAction;
      } catch {
        /* fallthrough */
      }
    }
    throw new Error('无法解析模型输出为 JSON：' + s.slice(0, 120));
  }

  private actionToStep(action: LLMAction, result?: ActionExecutionResult): Step | null {
    const args = action.args || {};
    switch (action.action) {
      case 'click': {
        const openedNewTab = result?.openedNewTab === true;
        return {
          type: 'click',
          selector: args.selector || '',
          timeoutMs: 15000,
          waitNavigation: true,
          ...(openedNewTab ? { watchPopup: true, followPopup: true, popupTimeoutMs: 30000 } : {}),
        };
      }
      case 'type':
        return { type: 'type', selector: args.selector || '', text: args.text ?? '', timeoutMs: 10000 };
      case 'goto':
        return { type: 'goto', url: args.url || '', timeoutMs: 45000 };
      case 'wait':
        return { type: 'wait', ms: Math.max(100, Math.min(60000, Number(args.ms) || 1000)), timeoutMs: 60000 };
      case 'waitFor':
        return { type: 'waitFor', selector: args.selector || '', timeoutMs: 15000 };
      case 'waitForText':
        return { type: 'waitForText', selector: args.selector || 'body', includes: args.includes || '', timeoutMs: 15000 };
      case 'waitForUrl':
        return { type: 'waitForUrl', match: args.match || args.includes || args.url || '', timeoutMs: 30000 };
      case 'extract': {
        const mode = EXTRACT_MODES.includes(args.mode as ExtractMode) ? (args.mode as ExtractMode) : 'text';
        return {
          type: 'extract',
          selector: args.selector || '',
          mode,
          ...(args.attribute ? { attribute: args.attribute } : {}),
          ...(args.variable ? { variable: args.variable } : {}),
          multiple: args.multiple === 'true' || mode === 'list' || mode === 'table',
          required: args.required !== 'false',
          timeoutMs: 15000,
        };
      }
      default:
        return null;
    }
  }

  private induceStep(action: LLMAction, result: ActionExecutionResult): 'added' | 'duplicate' | 'unconfirmed' | 'unsupported' {
    // ok 只代表浏览器接受了操作。探索时的误点、无效重试即使派发成功，
    // 只要没有页面变化证据，就不能固化为之后会真实执行的技能步骤。
    if (!result.ok || !result.confirmed) return 'unconfirmed';
    const step = this.actionToStep(action, result);
    if (!step) return 'unsupported';

    // 模型偶尔会连续返回完全相同的操作。即使动态页面让两次操作都被
    // 判定为 confirmed，也只保留一次，避免生成技能出现成串重复点击。
    const previous = this.generatedSteps[this.generatedSteps.length - 1];
    if (previous && JSON.stringify(previous) === JSON.stringify(step)) return 'duplicate';
    this.generatedSteps.push(step);
    return 'added';
  }

  private pageObservation(before: PageState, after: PageState): ActionObservation {
    const beforeElements = JSON.stringify(before.elements || []);
    const afterElements = JSON.stringify(after.elements || []);
    const observation: ActionObservation = {
      urlBefore: before.url || '',
      urlAfter: after.url || '',
      urlChanged: (before.url || '') !== (after.url || ''),
      titleChanged: (before.title || '') !== (after.title || ''),
      textChanged: (before.text || '') !== (after.text || ''),
      interactiveElementsChanged: beforeElements !== afterElements,
      changed: false,
    };
    observation.changed =
      observation.urlChanged ||
      observation.titleChanged ||
      observation.textChanged ||
      observation.interactiveElementsChanged;
    return observation;
  }

  private emptyObservation(state: PageState): ActionObservation {
    return this.pageObservation(state, state);
  }

  private async execAction(action: LLMAction, beforeState: PageState): Promise<ActionExecutionResult> {
    if (!this.tab) {
      return {
        ok: false,
        confirmed: false,
        message: '无活跃标签',
        observation: this.emptyObservation(beforeState),
      };
    }
    const args = action.args || {};

    if (action.action === 'wait') {
      const ms = Math.max(100, Math.min(60000, Number(args.ms) || 1000));
      try {
        await this.signal.sleep(ms);
        const afterState = await this.readPage();
        const observation = this.pageObservation(beforeState, afterState);
        return {
          ok: true,
          confirmed: true,
          message: `已等待 ${ms} 毫秒并重新读取页面状态`,
          observation,
        };
      } catch (e) {
        return {
          ok: false,
          confirmed: false,
          message: (e as Error)?.message || String(e),
          observation: this.emptyObservation(beforeState),
        };
      }
    }

    if (action.action === 'extract') {
      const selector = String(args.selector || '').trim();
      if (!selector) {
        return {
          ok: false,
          confirmed: false,
          message: 'extract 缺少 selector',
          observation: this.emptyObservation(beforeState),
        };
      }
      const mode = EXTRACT_MODES.includes(args.mode as ExtractMode) ? (args.mode as ExtractMode) : 'text';
      try {
        const extracted = (await this.tab.inject(pageExtractData, [{
          selector,
          mode,
          attribute: args.attribute || '',
          multiple: args.multiple === 'true' || mode === 'list' || mode === 'table',
        }])) as PageExtractResult | undefined;
        const observation = this.emptyObservation(beforeState);
        if (!extracted?.ok) {
          return {
            ok: false,
            confirmed: false,
            message: extracted?.message || `提取失败：${selector}`,
            observation,
          };
        }
        return {
          ok: true,
          confirmed: true,
          message: extracted.message || `已提取 ${selector}`,
          evidence: { selector, mode, data: extracted.data, count: extracted.count },
          observation,
        };
      } catch (e) {
        return {
          ok: false,
          confirmed: false,
          message: (e as Error)?.message || String(e),
          observation: this.emptyObservation(beforeState),
        };
      }
    }

    if (action.action === 'waitForUrl') {
      const match = args.match || args.includes || args.url || '';
      if (!match) {
        return {
          ok: false,
          confirmed: false,
          message: 'waitForUrl 缺少 match',
          observation: this.emptyObservation(beforeState),
        };
      }
      try {
        await this.tab.waitUrl(match, 30000);
        await this.signal.sleep(500);
        const afterState = await this.readPage();
        const observation = this.pageObservation(beforeState, afterState);
        return {
          ok: true,
          confirmed: true,
          message: `URL 已匹配：${match}`,
          observation,
        };
      } catch (e) {
        return {
          ok: false,
          confirmed: false,
          message: (e as Error)?.message || String(e),
          observation: this.emptyObservation(beforeState),
        };
      }
    }

    if (action.action === 'goto') {
      if (!args.url) {
        return {
          ok: false,
          confirmed: false,
          message: 'goto 缺少 url',
          observation: this.emptyObservation(beforeState),
        };
      }
      await chrome.tabs.update(this.tab.id, { url: args.url });
      await this.tab.waitComplete(45000, 600);
      const afterState = await this.readPage();
      const observation = this.pageObservation(beforeState, afterState);
      return {
        ok: true,
        confirmed: observation.changed,
        message: observation.changed ? '已跳转并观察到页面变化' : '已请求跳转，但页面暂无可观察变化',
        observation,
      };
    }

    const step = action.action === 'click'
      ? { type: 'click' as const, selector: args.selector || '', timeoutMs: DEFAULT_STEP_TIMEOUT }
      : action.action === 'type'
        ? { type: 'type' as const, selector: args.selector || '', text: args.text ?? '', timeoutMs: DEFAULT_STEP_TIMEOUT }
        : action.action === 'waitFor'
          ? { type: 'waitFor' as const, selector: args.selector || '', timeoutMs: DEFAULT_STEP_TIMEOUT }
          : action.action === 'waitForText'
            ? { type: 'waitForText' as const, selector: args.selector || 'body', includes: args.includes || '', timeoutMs: DEFAULT_STEP_TIMEOUT }
            : null;
    if (!step) {
      return {
        ok: false,
        confirmed: false,
        message: `未知操作：${action.action}`,
        observation: this.emptyObservation(beforeState),
      };
    }
    if ('selector' in step && !step.selector) {
      return {
        ok: false,
        confirmed: false,
        message: `${action.action} 缺少 selector`,
        observation: this.emptyObservation(beforeState),
      };
    }

    try {
      const beforeTabIds = action.action === 'click'
        ? new Set((await chrome.tabs.query({})).map((tab) => tab.id))
        : null;
      const result = await this.tab.inject(execPageAction, [step]);
      let openedTab: chrome.tabs.Tab | null = null;
      if (action.action === 'click' && beforeTabIds) {
        openedTab = await this.waitForOpenedTab(beforeTabIds, this.tab.id, 5000);
        // 某些站点通过合成 click 打开 _blank 链接时会被浏览器拦截，
        // 但页面仍能提供确定的 href。对安全的 http(s) 链接做一次兜底打开，
        // 让探索不会停在原页面并把后续步骤误判成未确认。
        if (!openedTab && result?.evidence && typeof result.evidence === 'object') {
          const evidence = result.evidence as { href?: unknown; targetBlank?: unknown };
          const href = typeof evidence.href === 'string' ? evidence.href : '';
          if (evidence.targetBlank === true && /^https?:\/\//i.test(href)) {
            openedTab = await chrome.tabs.create({ url: href, active: true });
          }
        }
        if (openedTab?.id != null) {
          const popup = TabSession.attach(openedTab.id, this.signal);
          await popup.waitComplete(30000, 600);
          this.tab = popup;
        } else {
          await this.tab.waitComplete(20000, 600);
        }
      }
      const afterState = await this.readPage();
      const observation = this.pageObservation(beforeState, afterState);
      if (!result) {
        return {
          ok: observation.changed,
          confirmed: observation.changed,
          message: observation.changed
            ? '执行上下文无返回，但已观察到页面变化'
            : '页面执行无返回，且未观察到页面变化',
          openedTabId: openedTab?.id,
          openedNewTab: !!openedTab,
          observation,
        };
      }

      const needsObservablePageChange = action.action === 'click';
      const confirmed = result.ok && (!needsObservablePageChange || observation.changed);
      const message = result.ok
        ? confirmed
          ? `${result.message}；已观察到页面变化`
          : `${result.message}；页面暂无可观察变化，业务结果未确认`
        : result.message;
      return {
        ok: result.ok,
        confirmed,
        message,
        evidence: result.evidence,
        openedTabId: openedTab?.id,
        openedNewTab: !!openedTab,
        observation,
      };
    } catch (e) {
      return {
        ok: false,
        confirmed: false,
        message: (e as Error)?.message || String(e),
        observation: this.emptyObservation(beforeState),
      };
    }
  }

  private async waitForOpenedTab(
    beforeTabIds: Set<number | undefined>,
    openerTabId: number,
    timeoutMs: number
  ): Promise<chrome.tabs.Tab | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      this.signal.check();
      const tabs = await chrome.tabs.query({});
      const fresh = tabs.filter((tab) => tab.id != null && !beforeTabIds.has(tab.id) && tab.id !== openerTabId);
      const child = fresh.find((tab) => tab.openerTabId === openerTabId) || (fresh.length === 1 ? fresh[0] : null);
      if (child) return child;
      await this.signal.sleep(150);
    }
    return null;
  }
}

// —— 模块级薄导出 ——

let currentSession: ExplorationSession | null = null;

export function abortExploration(): void {
  if (currentSession) {
    currentSession.abort();
    currentSession = null;
  }
}

export async function exploreAndGenerate(
  url: string,
  goal: string,
  successKws: string[] = [],
  settings: Settings = {} as Settings,
  onProgress: (progress: ExploreProgress) => void = () => {}
): Promise<ExplorationResult> {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('请提供合法的 http(s) 目标网址');
  if (!goal) throw new Error('请描述目标');

  const session = new ExplorationSession(url, goal, successKws, settings, onProgress);
  currentSession = session;
  try {
    return await session.run();
  } finally {
    if (currentSession === session) currentSession = null;
  }
}
