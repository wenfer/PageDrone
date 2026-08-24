/**
 * AI 对话。
 *
 * 用户在设置页的对话框里发一句自然语言指令，这里驱动大模型用 agent-skills.ts
 * 里的内置 AI 工具去创建可编排技能（Procedure）与流程（Flow）。
 *
 * 降低不确定性的三个约定（另见 agent-skills.ts 顶部注释）：
 *  - 每轮只让模型输出「一个」AI 工具调用，执行结果立刻回灌。不用「一次输出一串操作」，
 *    因为那样模型会在后面的工具调用里引用前面尚未产生的 id，且中途失败难以回滚。
 *  - AI 工具目录由 SKILLS 表自动生成，prompt 与校验逻辑不可能漂移。
 *  - 校验失败不算一次「失败」，而是把正确签名回灌让模型自己改，至多 MAX_REPAIR_ROUNDS 轮。
 *
 * 会话历史持久化到 chrome.storage.local；运行中的 LLM 请求无法跨 Service Worker
 * 重启恢复，因此重启后会将该轮明确标记为“已中断”，避免伪装成仍在执行。
 */

import { CancellationToken } from './cancellation.js';
import { LlmClient } from './llm.js';
import {
  getAgentChatSessions,
  getProcedures,
  getRuntime,
  getSettings,
  getSites,
  removeAgentChatSession,
  setRuntime,
  upsertAgentChatSession,
} from './storage.js';
import { getFlows } from './flows.js';
import {
  executeSkill,
  renderSkillCatalog,
  summarizeFlow,
  summarizeProcedure,
  summarizeSite,
  validateSkillCall,
  redactAgentValue,
  type SkillContext,
  type SkillResult,
} from './agent-skills.js';
import type { Settings } from './models.js';
import type {
  AgentThinkingStep,
  AgentChatSessionRecord,
  AgentChatSessionSummary,
  ChatTurn,
  SkillTrace,
} from './types.js';

export type { AgentChatSessionRecord, AgentChatSessionSummary, ChatTurn, SkillTrace } from './types.js';

export interface AgentReply {
  ok: boolean;
  /** 'ask' 表示代理反问、等用户回复；'done' 表示本轮结束 */
  halt: 'ask' | 'done' | 'error';
  text: string;
  traces: SkillTrace[];
  thinking?: AgentThinkingStep[];
  touched: { kind: 'procedure' | 'site' | 'flow'; id: string; name: string }[];
}

/** 校验失败后允许模型自我修正的轮数。超过就放弃，把原始输出摊给用户看。 */
const MAX_REPAIR_ROUNDS = 2;
const DEFAULT_MAX_TURNS = 15;
type ThinkingStepDraft = Omit<AgentThinkingStep, 'id' | 'turn' | 'at'>;

function buildSystemPrompt(thinkingEnabled: boolean): string {
  const outputExample = thinkingEnabled
    ? '{"thought":"用 1-3 句话说明已知事实、判断和下一步","skill":"AI 工具名","args":{...}}'
    : '{"skill":"AI 工具名","args":{...}}';
  return `你是浏览器自动化扩展 PageDrone 的智能助手。用户用自然语言描述需求，你通过调用「AI 工具」来帮他创建和修改可编排技能（Procedure）与流程（Flow）。

概念对照（务必分清）：
- 站点（Site）：一个目标网站及其网址、默认执行技能与定时配置。
- 可编排技能（Procedure）：必须通过 siteId 归属于一个站点；一个站点可以拥有多个技能。kind 为 "checkin"（自动化技能）、"login"（登录技能）或 "verification"（验证技能）。
- 流程（Flow）：把多个网站下的可编排技能串起来的节点图；技能节点同时携带 siteId 与 procedureId。

注意：本轮 JSON 中的 skill 字段指 AI 工具名（如 list-procedures、create-procedure），不是用户配置的可编排技能；浏览器 click/type/goto 等称为操作。

${renderSkillCatalog()}

快捷命令（斜杠只是便于用户选择的入口，不是 AI 工具名）：
- /检查技能：先列出技能，再查看指定技能配置和日志
- /查看技能：读取指定技能完整配置
- /修复技能：读取配置和日志，定位后修复并重新验证（仅在用户明确要求修复时写入）
- /测试技能：调用 test-procedure，实时观察页面并报告问题，不修改数据
- /测试流程：调用 list-flows / test-flow，复用正式流程引擎并报告问题，不修改数据
- /查看站点、/查看日志、/读取页面、/创建技能：分别执行对应的只读查询或创建引导
用户可能在斜杠命令后继续输入技能名、流程名、网址或补充要求；保留这些上下文。

输出格式（严格遵守）：
每次只输出一个 JSON 对象，不要输出任何解释性文字、不要用 markdown 代码块包裹：
${outputExample}
${thinkingEnabled ? '当前已开启思考模式：thought 是给用户预览的可公开决策摘要，只写依据、判断和下一步，不要输出隐藏推理、敏感值或冗长自言自语。' : '当前为快速模式：无需输出 thought，直接选择下一个 AI 工具。'}

工作原则：
1. 每轮只调用一个 AI 工具。我会把准确的执行结果告诉你，你再决定下一步。
2. 用户要测试或修复技能时，先用 test-procedure 获取真实页面观察和失败步骤；必要时再用 get-procedure、get-site、list-logs 对照配置和历史。测试报告中的 testOk=false 是被测对象失败，不代表测试工具没有返回结果。
   - test-procedure 返回 status=need_login 或 loginRequired=true 时，表示绑定站点需要登录，不代表 OAuth。先依据 loginSignals 和页面观察判断：ordinaryFormLikely=true 才能称为普通表单登录；没有弹窗/授权事实时不得称为 OAuth。不要要求用户回复“已登录”作为继续条件，也不要把普通表单登录描述成 OAuth。登录技能必须使用 click/goto/wait/waitFor/waitForUrl 等标准动作，不能写入 manual 人工步骤；执行器会在登录入口或表单出现后自动提交 Chrome 已保存账号密码。若没有自动填充或提交后仍未检测到登录态，先提示用户到站点列表打开该站点并手动完成登录，完成后再测试。禁止读取、输出或填写密码字段内容。
3. 用户要测试或修复流程时，先用 list-flows 获取真实 flowId，再用 test-flow 复用正式画布引擎执行；发现问题后用 get-flow 读取完整节点数据，修改节点时优先用 update-flow-node，修改后必须重新 test-flow/test-procedure 验证。
4. 用户明确要求“测试并修复/自动修复”时，可以根据页面观察、失败步骤和准确工具结果自主选择 update-step、replace-steps、update-procedure 或 set-detect；只测试、分析或报告问题时不得修改技能、流程、日志，但 test-procedure 确认登录失效时可以更新站点的“需要登录”提示状态。
5. 创建技能前先调用 list-sites 获取所属网站的真实 siteId；修改已有技能或站点时先读取真实 id。绝对不要自己编造 id。
6. 写页面选择器（selector）之前，如果没有可靠依据，先用 read-page 或 test-procedure 的页面观察看清真实 DOM 结构。不要凭猜写 selector。
7. replace-steps 会覆盖整个步骤数组，只有用户明确要求重写/修复步骤时才能调用；普通小改优先用 update-step。
8. explore-page 很贵（多轮大模型调用 + 真实浏览器操作），只在用户明确要求「分析某页面并自动生成整套步骤」时才用；调用时同样必须提供目标网站的 siteId，生成结果会归属于该网站。
9. 不要索取、输出或猜测 API Key、Cookie、密码等敏感设置；本地诊断数据只用于完成用户当前请求。
10. 信息不足时用 ask 向用户提问，不要脑补用户没说的网址、账号或选择器。
11. 全部做完后用 done 给一个简明总结。总结面向用户，说清你创建了什么、他接下来该做什么。
12. 用中文与用户交流。
13. 即使开启思考模式，也不得在 thought 中复述 API Key、Cookie、密码、Token 或其他敏感值。`;
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function sessionTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 32 ? `${oneLine.slice(0, 32)}…` : oneLine || '新对话';
}

function publicThinkingText(value: string, maxLength = 800): string {
  return String(value || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[已隐藏]')
    .replace(/\b(api[-_ ]?key|authorization|cookie|password|passwd|secret|token|credential)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .trim()
    .slice(0, maxLength);
}

function rebuildScratch(turns: ChatTurn[]): string[] {
  const scratch: string[] = [];
  for (const turn of turns) {
    if (turn.role === 'user') {
      scratch.push(`用户：${turn.text}`);
      continue;
    }
    for (const trace of turn.traces || []) {
      const safeArgs = redactAgentValue(trace.args) as Record<string, unknown>;
      scratch.push(
        `你调用了 ${trace.skill}(${JSON.stringify(safeArgs)})\n结果：${trace.ok ? trace.summary : `失败 - ${trace.summary}`}`
      );
    }
    scratch.push(`你：${turn.text}`);
  }
  return scratch;
}

export class AgentChatSession {
  /** 对用户可见、并持久化的对话历史。 */
  readonly turns: ChatTurn[];
  /** 喂给模型的内部轨迹；从持久 turn 可重建，避免依赖 SW 内存。 */
  private scratch: string[];
  private signal = new CancellationToken();
  private busy = false;
  private activeRunId = '';
  private thinkingEnabled = false;
  private thinkingSteps: AgentThinkingStep[] = [];
  private progressWrite: Promise<unknown> = Promise.resolve();

  constructor(private record: AgentChatSessionRecord) {
    this.turns = record.turns;
    this.scratch = rebuildScratch(this.turns);
  }

  get id(): string {
    return this.record.id;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  snapshot(): AgentChatSessionRecord {
    return structuredClone({ ...this.record, turns: this.turns });
  }

  abort(): void {
    this.signal.abort();
  }

  async reset(): Promise<void> {
    if (this.busy) throw new Error('AI 对话仍在处理中，请先停止并等待当前响应结束');
    this.turns.length = 0;
    this.scratch = [];
    this.record.title = '新对话';
    this.record.status = 'idle';
    delete this.record.activeRunId;
    this.record.updatedAt = Date.now();
    await this.persist();
  }

  private async persist(): Promise<void> {
    await upsertAgentChatSession(this.snapshot());
  }

  private async progress(message: string, turn?: number, thinking?: ThinkingStepDraft): Promise<void> {
    if (this.thinkingEnabled && thinking) {
      this.thinkingSteps.push({
        ...thinking,
        id: uid('thinking'),
        turn: turn ?? this.thinkingSteps.at(-1)?.turn ?? 0,
        at: Date.now(),
        ...(thinking.detail ? { detail: publicThinkingText(thinking.detail) } : {}),
      });
    }
    const payload = {
      agentProgress: {
        sessionId: this.id,
        runId: this.activeRunId,
        ...(turn == null ? {} : { turn }),
        message,
        at: Date.now(),
        thinkingEnabled: this.thinkingEnabled,
        ...(this.thinkingEnabled ? { thinking: [...this.thinkingSteps] } : {}),
      },
    };
    this.progressWrite = this.progressWrite.catch(() => undefined).then(() => setRuntime(payload));
    await this.progressWrite;
  }

  /**
   * 处理一条用户消息，驱动「决策 → 校验 → 执行 → 回灌」循环直到 done / ask / 用尽轮数。
   */
  async send(userText: string, runId: string): Promise<AgentReply> {
    if (this.busy) throw new Error('上一条指令还在处理中，请稍候或点“停止”');

    // 在第一个 await 之前占锁，消除并发 SEND 同时越过 busy 检查的窗口。
    this.busy = true;
    this.activeRunId = runId;
    this.signal = new CancellationToken();
    this.thinkingEnabled = false;
    this.thinkingSteps = [];
    this.progressWrite = Promise.resolve();
    this.record.status = 'running';
    this.record.activeRunId = runId;
    if (!this.turns.length) this.record.title = sessionTitle(userText);
    this.turns.push({ id: uid('turn'), role: 'user', text: userText, at: Date.now() });
    this.scratch.push(`用户：${userText}`);
    this.record.updatedAt = Date.now();

    const traces: SkillTrace[] = [];
    const touched: AgentReply['touched'] = [];

    try {
      await this.persist();
      const settings = await getSettings();
      if (!settings.llmApiKey) {
        return await this.finish(traces, touched, 'error', '未配置大模型 API Key，请到“设置 → AI 设置”填写。');
      }

      this.thinkingEnabled = settings.agentThinkingMode !== false;
      const maxTurns = settings.agentMaxSteps || DEFAULT_MAX_TURNS;
      this.signal.setDeadline(settings.agentTimeoutMs || 300000);
      const client = this.buildClient(settings);

      for (let turn = 1; turn <= maxTurns; turn++) {
        if (this.signal.isAborted) {
          return await this.finish(traces, touched, 'error', '已被用户停止。');
        }
        await this.progress(`第 ${turn} 轮：思考中…`, turn, {
          stage: 'thinking',
          title: `第 ${turn} 轮：分析上下文`,
          detail: '结合当前站点、技能、对话历史和上一轮工具结果，准备下一步决策。',
        });

        const ctx = await this.buildContext(settings);
        const decision = await this.decide(client, ctx, turn);
        if (!decision.ok) {
          return await this.finish(traces, touched, 'error', decision.error);
        }

        const { skill, args, thought } = decision;
        const publicThought = this.thinkingEnabled ? publicThinkingText(thought) : '';
        await this.progress(`第 ${turn} 轮：${skill}`, turn, {
          stage: 'decision',
          title: `决定调用 ${skill}`,
          ...(publicThought ? { detail: publicThought } : {}),
          skill,
        });

        const result = await this.runSkill(skill, args, ctx);
        const safeArgs = redactAgentValue(args) as Record<string, unknown>;
        const trace = {
          skill,
          args: safeArgs,
          thought: publicThought,
          ok: result.ok,
          summary: this.describeResult(result),
        };
        traces.push(trace);
        if (result.touched) touched.push(...result.touched);
        await this.progress(`第 ${turn} 轮：${skill}${result.ok ? '完成' : '失败'}`, turn, {
          stage: 'result',
          title: result.ok ? `${skill} 执行成功` : `${skill} 执行失败`,
          detail: trace.summary,
          skill,
          ok: result.ok,
        });

        // AI 工具执行的准确响应立即回灌模型；界面在最终消息的轨迹中展示同一份 summary。
        this.scratch.push(
          `你调用了 ${skill}(${JSON.stringify(safeArgs)})\n结果：${
            result.ok ? JSON.stringify(result.data ?? {}) : `失败 - ${result.error}`
          }`
        );

        if (result.halt === 'ask') {
          return await this.finish(traces, touched, 'ask', result.text || '需要你补充一些信息。');
        }
        if (result.halt === 'done') {
          return await this.finish(traces, touched, 'done', result.text || '已完成。');
        }
      }

      return await this.finish(
        traces,
        touched,
        'done',
        `已达到单轮最大步数（${maxTurns}）仍未结束。已完成的改动见上方，可以再发一条指令继续。`
      );
    } catch (e) {
      return await this.finish(traces, touched, 'error', `处理失败：${(e as Error)?.message || String(e)}`);
    } finally {
      this.busy = false;
      const finishedRunId = this.activeRunId;
      if (this.record.activeRunId === finishedRunId) {
        this.record.status = 'idle';
        delete this.record.activeRunId;
        this.record.updatedAt = Date.now();
        await this.persist().catch(() => undefined);
      }
      await this.progressWrite.catch(() => undefined);
      const runtime = await getRuntime().catch(() => null);
      const progress = runtime?.agentProgress as { sessionId?: string; runId?: string } | null | undefined;
      if (progress?.sessionId === this.id && progress.runId === finishedRunId) {
        await setRuntime({ agentProgress: null }).catch(() => undefined);
      }
      this.activeRunId = '';
      this.thinkingEnabled = false;
      this.thinkingSteps = [];
    }
  }

  private buildClient(settings: Settings): LlmClient {
    return new LlmClient({
      provider: settings.llmProvider || 'anthropic',
      apiKey: settings.llmApiKey || '',
      baseUrl: settings.llmBaseUrl,
      model: settings.llmModel,
      headers: settings.llmHeaders,
    });
  }

  private async buildContext(settings: Settings): Promise<SkillContext> {
    // 每轮重新读，因为上一轮的 AI 工具可能刚写入了新技能
    const [procedures, sites, flows] = await Promise.all([getProcedures(), getSites(), getFlows()]);
    return {
      procedures,
      sites,
      flows,
      settings,
      signal: this.signal,
      onProgress: (m) => {
        void this.progress(m);
      },
    };
  }

  /**
   * 让模型给出一个 AI 工具调用，并当场校验。
   * 校验不过就把错误回灌重来——这是「自我修正」而非「失败」，所以不计入主循环轮数。
   */
  private async decide(
    client: LlmClient,
    ctx: SkillContext,
    turn: number
  ): Promise<
    { ok: true; skill: string; args: Record<string, unknown>; thought: string } | { ok: false; error: string }
  > {
    let repairHint = '';
    let lastRaw = '';

    for (let attempt = 0; attempt <= MAX_REPAIR_ROUNDS; attempt++) {
      this.signal.check();
      const prompt = this.buildUserPrompt(ctx, repairHint);
      let raw: string;
      try {
        raw = await client.chat({
          system: buildSystemPrompt(this.thinkingEnabled),
          user: prompt,
          maxTokens: this.thinkingEnabled ? 1280 : 1024,
          temperature: 0,
        });
      } catch (e) {
        return { ok: false, error: `调用大模型失败：${(e as Error)?.message || String(e)}` };
      }
      lastRaw = raw;

      const parsed = parseDecision(raw);
      if (!parsed.ok) {
        const example = this.thinkingEnabled
          ? '{"thought":"…","skill":"…","args":{…}}'
          : '{"skill":"…","args":{…}}';
        repairHint = `你上一次的输出无法解析为 JSON：${parsed.error}\n请只输出一个 JSON 对象，形如 ${example}，不要加任何其他文字。`;
        await this.progress(`第 ${turn} 轮：输出格式有误，正在纠正…`, turn, {
          stage: 'repair',
          title: '修正模型输出格式',
          detail: parsed.error,
        });
        continue;
      }

      const check = validateSkillCall(parsed.skill, parsed.args, ctx);
      if (!check.ok) {
        // 把正确签名 / 真实可用 id 回灌，比让模型自己猜有效得多
        repairHint = `你上一次的调用无效：${check.error}\n请修正后重新输出一个 JSON 对象。`;
        await this.progress(`第 ${turn} 轮：参数有误，正在纠正…`, turn, {
          stage: 'repair',
          title: '修正 AI 工具调用参数',
          detail: check.error,
          skill: parsed.skill,
          ok: false,
        });
        continue;
      }

      return { ok: true, skill: parsed.skill, args: parsed.args, thought: parsed.thought };
    }

    return {
      ok: false,
      error: `模型连续 ${MAX_REPAIR_ROUNDS + 1} 次给出无效调用，已中止。最后一次原始输出：\n${lastRaw.slice(0, 300)}`,
    };
  }

  private buildUserPrompt(ctx: SkillContext, repairHint: string): string {
    // 每轮都附真实的 id 清单，这是消灭 id 幻觉最有效的一招
    const procLines = ctx.procedures.length
      ? ctx.procedures.map((p) => `  ${JSON.stringify(summarizeProcedure(p))}`).join('\n')
      : '  （暂无技能）';
    const siteLines = ctx.sites.length
      ? ctx.sites.map((s) => `  ${JSON.stringify(summarizeSite(s))}`).join('\n')
      : '  （暂无站点）';
    const flowLines = ctx.flows.length
      ? ctx.flows.map((flow) => `  ${JSON.stringify(summarizeFlow(flow))}`).join('\n')
      : '  （暂无流程）';

    const parts = [
      '当前扩展内的真实数据（id 必须从这里取，不要自己编）：',
      '已有可编排技能：',
      procLines,
      '已有站点：',
      siteLines,
      '已有流程：',
      flowLines,
      '',
      '对话与执行记录：',
      this.scratch.join('\n'),
    ];
    if (repairHint) {
      parts.push('', `【纠正】${repairHint}`);
    } else {
      parts.push('', '请输出下一个 AI 工具调用的 JSON。');
    }
    return parts.join('\n');
  }

  private async runSkill(
    skill: string,
    args: Record<string, unknown>,
    ctx: SkillContext
  ): Promise<SkillResult> {
    try {
      return await executeSkill(skill, args, ctx);
    } catch (e) {
      // AI 工具内部异常不该炸掉整个会话；转成可回灌的失败，让模型换个思路
      return { ok: false, error: `执行 ${skill} 时出错：${(e as Error)?.message || String(e)}` };
    }
  }

  private describeResult(r: SkillResult): string {
    if (!r.ok) return r.error || '失败';
    if (r.halt) return r.text || '';
    const d = r.data || {};
    const compact = JSON.stringify(d);
    const prefix = d.testOk === false ? '被测对象失败：' : '';
    const body = compact.length > 200 ? `${compact.slice(0, 200)}…` : compact;
    return `${prefix}${body}`;
  }

  private async finish(
    traces: SkillTrace[],
    touched: AgentReply['touched'],
    halt: AgentReply['halt'],
    text: string
  ): Promise<AgentReply> {
    if (this.record.activeRunId !== this.activeRunId) {
      return { ok: false, halt: 'error', text: '本次响应已失效。', traces: [], touched: [] };
    }
    this.turns.push({
      id: uid('turn'),
      role: 'agent',
      text,
      at: Date.now(),
      status: halt === 'error' ? 'error' : halt === 'ask' ? 'question' : 'success',
      traces: [...traces],
      ...(this.thinkingEnabled ? { thinking: [...this.thinkingSteps] } : {}),
      touched: [...touched],
    });
    this.scratch.push(`你：${text}`);
    this.record.status = 'idle';
    delete this.record.activeRunId;
    this.record.updatedAt = Date.now();
    await this.persist();
    return {
      ok: halt !== 'error',
      halt,
      text,
      traces,
      ...(this.thinkingEnabled ? { thinking: [...this.thinkingSteps] } : {}),
      touched,
    };
  }
}

/** 解析模型输出的单个 AI 工具调用。容错逻辑与 explorer.ts 的 parseAction 一致。 */
function parseDecision(
  text: string
): { ok: true; skill: string; args: Record<string, unknown>; thought: string } | { ok: false; error: string } {
  if (!text || !text.trim()) return { ok: false, error: '模型无输出' };
  const s = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  let obj: unknown = null;
  try {
    obj = JSON.parse(s);
  } catch {
    // 退化：截取首尾大括号之间的部分，容忍模型在 JSON 前后多说了话
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        obj = JSON.parse(s.slice(start, end + 1));
      } catch {
        /* fallthrough */
      }
    }
  }
  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: `无法解析为 JSON：${s.slice(0, 120)}` };
  }

  const o = obj as Record<string, unknown>;
  const skill = typeof o.skill === 'string' ? o.skill : typeof o.action === 'string' ? o.action : '';
  if (!skill) return { ok: false, error: '缺少 skill 字段' };
  const rawArgs = o.args;
  const args =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  const thought = typeof o.thought === 'string' ? o.thought : typeof o.reason === 'string' ? o.reason : '';
  return { ok: true, skill, args, thought };
}

// —— 多会话注册表与持久化 API ——

const sessions = new Map<string, AgentChatSession>();
let activeRun: { sessionId: string; runId: string } | null = null;

function newSessionRecord(): AgentChatSessionRecord {
  const now = Date.now();
  return {
    id: uid('chat'),
    title: '新对话',
    turns: [],
    status: 'idle',
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeRecord(record: AgentChatSessionRecord): AgentChatSessionRecord {
  return {
    ...record,
    title: record.title || '新对话',
    status: record.status || 'idle',
    turns: Array.isArray(record.turns)
      ? record.turns.map((turn) => ({ ...turn, id: turn.id || uid('turn') }))
      : [],
  };
}

async function hydrate(record: AgentChatSessionRecord): Promise<AgentChatSession> {
  const normalized = normalizeRecord(record);
  if (normalized.status === 'running') {
    normalized.status = 'interrupted';
    delete normalized.activeRunId;
    normalized.updatedAt = Date.now();
    normalized.turns.push({
      id: uid('turn'),
      role: 'agent',
      status: 'error',
      text: '上一次响应因扩展后台休眠或重启而中断，请重新发送该指令。',
      at: normalized.updatedAt,
    });
    await upsertAgentChatSession(normalized);
  }
  const session = new AgentChatSession(normalized);
  sessions.set(normalized.id, session);
  return session;
}

async function findSession(id: string): Promise<AgentChatSession | null> {
  const cached = sessions.get(id);
  if (cached) return cached;
  const record = (await getAgentChatSessions()).find((item) => item.id === id);
  return record ? hydrate(record) : null;
}

export async function createAgentSession(): Promise<AgentChatSessionRecord> {
  const record = newSessionRecord();
  await upsertAgentChatSession(record);
  sessions.set(record.id, new AgentChatSession(record));
  return structuredClone(record);
}

export async function ensureAgentSession(id?: string): Promise<AgentChatSessionRecord> {
  if (id) {
    const existing = await findSession(id);
    if (!existing) throw new Error('会话不存在或已被删除');
    return existing.snapshot();
  }
  return createAgentSession();
}

export interface AgentRunHandle {
  sessionId: string;
  runId: string;
  completion: Promise<AgentReply>;
}

export async function startAgentMessage(text: string, sessionId: string): Promise<AgentRunHandle> {
  const value = String(text || '').trim();
  if (!value) throw new Error('消息内容为空');
  const session = await findSession(sessionId);
  if (!session) throw new Error('会话不存在或已被删除');
  if (activeRun || session.isBusy) throw new Error('已有 AI 对话正在处理，请等待完成或先停止');

  const runId = uid('run');
  activeRun = { sessionId, runId };
  const completion = session.send(value, runId).finally(() => {
    if (activeRun?.runId === runId) activeRun = null;
  });
  return { sessionId, runId, completion };
}

export function abortAgent(sessionId: string): boolean {
  if (!activeRun || activeRun.sessionId !== sessionId) return false;
  sessions.get(sessionId)?.abort();
  return true;
}

export async function resetAgentSession(sessionId: string): Promise<AgentChatSessionRecord> {
  const session = await findSession(sessionId);
  if (!session) throw new Error('会话不存在或已被删除');
  await session.reset();
  return session.snapshot();
}

export async function deleteAgentSession(sessionId: string): Promise<void> {
  if (activeRun?.sessionId === sessionId) throw new Error('当前会话仍在处理中，请先停止');
  sessions.delete(sessionId);
  await removeAgentChatSession(sessionId);
}

function summarizeSession(record: AgentChatSessionRecord): AgentChatSessionSummary {
  const lastTurn = record.turns.at(-1);
  const preview = lastTurn?.text.replace(/\s+/g, ' ').trim() || '还没有消息';
  return {
    id: record.id,
    title: record.title,
    preview: preview.length > 64 ? `${preview.slice(0, 64)}…` : preview,
    turnCount: record.turns.length,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function getAgentHistory(sessionId?: string): Promise<{
  sessions: AgentChatSessionSummary[];
  session: AgentChatSessionRecord | null;
  busySessionId: string | null;
}> {
  const stored = await getAgentChatSessions();
  const merged = new Map<string, AgentChatSessionRecord>();
  for (const record of stored) {
    // Map 为空但落盘状态仍是 running，说明承载该请求的 SW 已被回收。
    const value = record.status === 'running' && !sessions.has(record.id)
      ? (await hydrate(record)).snapshot()
      : normalizeRecord(record);
    merged.set(value.id, value);
  }
  for (const [id, session] of sessions) merged.set(id, session.snapshot());
  const records = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const selectedId = sessionId || records[0]?.id;
  return {
    sessions: records.map(summarizeSession),
    session: selectedId ? structuredClone(merged.get(selectedId) || null) : null,
    busySessionId: activeRun?.sessionId || null,
  };
}
