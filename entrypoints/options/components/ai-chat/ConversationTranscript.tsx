import { useEffect, useRef, useState } from 'react';
import {
  BrainCircuit,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  LoaderCircle,
  Settings2,
  User,
  Wrench,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AgentThinkingStep, ChatTurn, SkillTrace } from '../../../../src/lib/types.js';
import { formatMessageDate, formatMessageTime, redactValue, renderTraceArgs, sameCalendarDay } from './utils';

type TouchedEntity = NonNullable<ChatTurn['touched']>[number];

interface ConversationTranscriptProps {
  turns: ChatTurn[];
  pendingTurn: ChatTurn | null;
  busy: boolean;
  progress: string;
  thinkingEnabled: boolean;
  thinking: AgentThinkingStep[];
  error: string;
  apiConfigured: boolean;
  onUsePrompt: (prompt: string) => void;
  onOpenSettings: () => void;
  onOpenEntity: (entity: TouchedEntity) => void;
}

const SUGGESTIONS = [
  { title: '检查现有配置', text: '列出当前技能，并检查哪些站点还没有绑定自动化技能。' },
  { title: '创建网页自动化', text: '帮我创建一个新的网页自动化技能，请先问我网址和目标。' },
  { title: '分析当前页面', text: '读取当前页面，告诉我有哪些适合自动化的操作。' },
];

export function ConversationTranscript({
  turns,
  pendingTurn,
  busy,
  progress,
  thinkingEnabled,
  thinking,
  error,
  apiConfigured,
  onUsePrompt,
  onOpenSettings,
  onOpenEntity,
}: ConversationTranscriptProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const visibleTurns = pendingTurn && !turns.some((turn) => turn.id === pendingTurn.id) ? [...turns, pendingTurn] : turns;
  const lastTurnId = visibleTurns.at(-1)?.id;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: visibleTurns.length > 1 ? 'smooth' : 'auto' });
  }, [lastTurnId, busy, progress, error, visibleTurns.length]);

  return (
    <ScrollArea className="ai-chat-transcript" aria-live="polite">
      <div className="ai-chat-transcript-inner">
        {!visibleTurns.length ? (
          <ChatEmptyState apiConfigured={apiConfigured} onUsePrompt={onUsePrompt} onOpenSettings={onOpenSettings} />
        ) : visibleTurns.map((turn, index) => {
          const previous = visibleTurns[index - 1];
          const showDate = !previous || !sameCalendarDay(previous.at, turn.at);
          return (
            <div key={turn.id}>
              {showDate ? <div className="ai-chat-date"><span>{formatMessageDate(turn.at)}</span></div> : null}
              <Message turn={turn} pending={turn.id === pendingTurn?.id} onOpenEntity={onOpenEntity} />
            </div>
          );
        })}
        {busy ? <div className="ai-chat-live-block">
          <div className="ai-chat-thinking" role="status">
            <span className="ai-chat-avatar assistant"><LoaderCircle className="spin" aria-hidden="true" /></span>
            <div><strong>{thinkingEnabled ? 'AI 助手正在思考' : 'AI 助手正在处理'}</strong><p>{progress || '正在理解你的需求…'}</p></div>
          </div>
          {thinkingEnabled && thinking.length ? <ThinkingProcess steps={thinking} live /> : null}
        </div> : null}
        {error ? <div className="ai-chat-inline-error"><XCircle aria-hidden="true" /><span>{error}</span></div> : null}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}

function ChatEmptyState({ apiConfigured, onUsePrompt, onOpenSettings }: { apiConfigured: boolean; onUsePrompt: (prompt: string) => void; onOpenSettings: () => void }) {
  return <div className="ai-chat-empty">
    <span className="ai-chat-empty-icon"><Bot aria-hidden="true" /></span>
    <h2>{apiConfigured ? '开始一段 AI 对话' : '配置 AI 后开始对话'}</h2>
    <p>{apiConfigured ? '描述你想创建、检查或调整的网页自动化，AI 助手会展示每次 AI 工具调用的真实结果。' : '需要先保存大模型 API Key。配置完成后无需刷新，本页会立即同步。'}</p>
    {!apiConfigured ? <Button onClick={onOpenSettings}><Settings2 aria-hidden="true" />前往 AI 设置</Button> : null}
    {apiConfigured ? <div className="ai-chat-suggestions">{SUGGESTIONS.map((suggestion) => <button type="button" key={suggestion.title} onClick={() => onUsePrompt(suggestion.text)}><span><strong>{suggestion.title}</strong><small>{suggestion.text}</small></span><ChevronRight aria-hidden="true" /></button>)}</div> : null}
  </div>;
}

function Message({ turn, pending, onOpenEntity }: { turn: ChatTurn; pending: boolean; onOpenEntity: (entity: TouchedEntity) => void }) {
  const user = turn.role === 'user';
  const status = turn.status;
  const thinking = user ? [] : thinkingStepsForTurn(turn);
  return <article className={`ai-chat-message ${user ? 'user' : 'assistant'}${status === 'error' ? ' has-error' : ''}`}>
    <span className={`ai-chat-avatar ${user ? 'user' : 'assistant'}`}>{user ? <User aria-hidden="true" /> : <Bot aria-hidden="true" />}</span>
    <div className="ai-chat-message-main">
      <header>
        <strong>{user ? '你' : 'AI 助手'}</strong>
        {status === 'question' ? <Badge variant="warning"><CircleHelp aria-hidden="true" />等待回复</Badge> : null}
        {status === 'error' ? <Badge variant="destructive"><XCircle aria-hidden="true" />未完成</Badge> : null}
        {status === 'success' && !user ? <Badge variant="success"><CheckCircle2 aria-hidden="true" />已完成</Badge> : null}
        {pending ? <Badge variant="outline">发送中</Badge> : null}
        <Tooltip>
          <TooltipTrigger asChild><time dateTime={new Date(turn.at).toISOString()}>{formatMessageTime(turn.at)}</time></TooltipTrigger>
          <TooltipContent>{new Date(turn.at).toLocaleString('zh-CN', { hour12: false })}</TooltipContent>
        </Tooltip>
      </header>
      {thinking.length ? <ThinkingProcess steps={thinking} /> : null}
      <Card className="ai-chat-message-card"><CardContent><p>{turn.text}</p></CardContent></Card>
      {turn.traces?.length ? <SkillTimeline traces={turn.traces} showThought={!thinking.length} /> : null}
      {turn.touched?.length ? <div className="ai-chat-touched"><span>本轮涉及</span>{turn.touched.map((entity) => <Button key={`${entity.kind}:${entity.id}`} variant="outline" size="sm" onClick={() => onOpenEntity(entity)}>{entityLabel(entity.kind)}：{entity.name}<ExternalLink aria-hidden="true" /></Button>)}</div> : null}
    </div>
  </article>;
}

function thinkingStepsForTurn(turn: ChatTurn): AgentThinkingStep[] {
  if (turn.thinking?.length) return turn.thinking;
  return (turn.traces || []).flatMap((trace, index) => trace.thought ? [{
    id: `legacy-thinking-${turn.id}-${index}`,
    turn: index + 1,
    stage: 'decision' as const,
    title: `决定调用 ${trace.skill}`,
    detail: trace.thought,
    skill: trace.skill,
    ok: trace.ok,
    at: turn.at,
  }] : []);
}

const THINKING_STAGE_LABEL: Record<AgentThinkingStep['stage'], string> = {
  thinking: '分析',
  decision: '决策',
  repair: '自我修正',
  result: '结果反馈',
};

function ThinkingProcess({ steps, live = false }: { steps: AgentThinkingStep[]; live?: boolean }) {
  const [open, setOpen] = useState(live);
  return <details className={`ai-chat-reasoning${live ? ' live' : ''}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <span><BrainCircuit aria-hidden="true" />{live ? '思考过程 · 实时' : '思考过程'}</span>
      <span className="ai-chat-reasoning-count">{steps.length} 步<ChevronRight aria-hidden="true" /></span>
    </summary>
    <div className="ai-chat-reasoning-list">
      {steps.map((step, index) => <div className={`ai-chat-reasoning-step ${step.stage}${step.ok === false ? ' has-error' : ''}`} key={step.id}>
        <span className="ai-chat-reasoning-index">{index + 1}</span>
        <div>
          <header><strong>{step.title}</strong><span>{THINKING_STAGE_LABEL[step.stage]}</span></header>
          {step.detail ? <p>{String(redactValue(step.detail))}</p> : null}
          {step.skill ? <code>{step.skill}</code> : null}
        </div>
      </div>)}
    </div>
  </details>;
}

function SkillTimeline({ traces, showThought = true }: { traces: SkillTrace[]; showThought?: boolean }) {
  const successful = traces.filter((trace) => trace.ok).length;
  return <details className="ai-chat-traces" open={traces.some((trace) => !trace.ok)}>
    <summary><span><Wrench aria-hidden="true" />AI 工具执行记录</span><Badge variant={successful === traces.length ? 'success' : 'warning'}>{successful}/{traces.length} 成功</Badge></summary>
    <div className="ai-chat-trace-list">{traces.map((trace, index) => <div className={`ai-chat-trace ${trace.ok ? 'success' : 'error'}`} key={`${trace.skill}-${index}`}><span className="ai-chat-trace-marker">{trace.ok ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}</span><div><header><strong>{trace.skill}</strong><Badge variant={trace.ok ? 'success' : 'destructive'}>{trace.ok ? '执行成功' : '执行失败'}</Badge></header>{showThought && trace.thought ? <p className="ai-chat-trace-thought">{trace.thought}</p> : null}<div className="ai-chat-trace-result"><span>实际结果</span><p>{trace.summary || (trace.ok ? '技能返回成功，但没有附加摘要。' : '技能返回失败，但没有附加摘要。')}</p></div><details className="ai-chat-trace-args"><summary>查看调用参数（敏感字段已隐藏）</summary><pre>{renderTraceArgs(trace)}</pre></details></div></div>)}</div>
  </details>;
}

function entityLabel(kind: TouchedEntity['kind']): string {
  if (kind === 'procedure') return '技能';
  if (kind === 'site') return '站点';
  return '流程';
}
