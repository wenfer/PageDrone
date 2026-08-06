import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Menu, Settings2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { MSG } from '../../../../src/lib/messaging.js';
import type {
  AgentChatSessionRecord,
  AgentChatSessionSummary,
  ChatTurn,
  RuntimeState,
  Settings,
} from '../../../../src/lib/types.js';
import { ChatComposer } from './ChatComposer';
import { ConversationSidebar } from './ConversationSidebar';
import { ConversationTranscript } from './ConversationTranscript';

type TouchedEntity = NonNullable<ChatTurn['touched']>[number];
type ServiceResponse<T> = T & { ok: boolean; error?: string };
type HistoryResponse = {
  sessions: AgentChatSessionSummary[];
  session: AgentChatSessionRecord | null;
  busySessionId: string | null;
};

interface LocalRun {
  sessionId: string;
  startedAt: number;
}

interface PendingMessage {
  sessionId: string;
  turn: ChatTurn;
}

interface AiChatPanelProps {
  settings: Settings;
  runtime: RuntimeState;
  notify: (text: string, error?: boolean) => void;
  onOpenSettings: () => void;
  onOpenEntity: (entity: TouchedEntity) => void;
}

async function request<T>(message: object): Promise<ServiceResponse<T>> {
  const response = await chrome.runtime.sendMessage(message) as ServiceResponse<T> | undefined;
  if (!response) throw new Error('扩展后台没有响应，请重新加载扩展');
  if (!response.ok) throw new Error(response.error || '操作失败');
  return response;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

export function AiChatPanel({ settings, runtime, notify, onOpenSettings, onOpenEntity }: AiChatPanelProps) {
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const [session, setSession] = useState<AgentChatSessionRecord | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [localRun, setLocalRun] = useState<LocalRun | null>(null);
  const [pendingMessage, setPendingMessage] = useState<PendingMessage | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [abortingSessionId, setAbortingSessionId] = useState<string | null>(null);
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const requestSequence = useRef(0);
  const handledResultRunId = useRef(runtime.agentResult?.runId);

  const loadHistory = useCallback(async (sessionId?: string, quiet = false) => {
    const sequence = ++requestSequence.current;
    try {
      const response = await request<HistoryResponse>({ type: MSG.AGENT_CHAT_HISTORY, ...(sessionId ? { sessionId } : {}) });
      if (sequence !== requestSequence.current) return null;
      setSessions(response.sessions || []);
      setSession(response.session || null);
      setBusySessionId(response.busySessionId || null);
      const loadedId = response.session?.id || null;
      setActiveSessionId(loadedId);
      if (loadedId) sessionStorage.setItem('auto-page/active-ai-chat', loadedId);
      else sessionStorage.removeItem('auto-page/active-ai-chat');
      setPendingMessage((pending) => {
        if (!pending || pending.sessionId !== loadedId) return pending;
        const accepted = response.session?.turns.some((turn) => turn.role === 'user' && turn.text === pending.turn.text && Math.abs(turn.at - pending.turn.at) < 30_000);
        return accepted ? null : pending;
      });
      setLocalRun((current) => {
        if (!current || response.busySessionId === current.sessionId) return current;
        const runSummary = response.sessions.find((item) => item.id === current.sessionId);
        const activeFinished = current.sessionId === loadedId && (response.session?.status === 'interrupted' || response.session?.turns.some((turn) => turn.role === 'agent' && turn.at >= current.startedAt));
        const backgroundFinished = current.sessionId !== loadedId && runSummary?.status !== 'running';
        const finished = activeFinished || backgroundFinished;
        return finished ? null : current;
      });
      if (response.session?.status === 'interrupted') setAbortingSessionId((current) => current === loadedId ? null : current);
      if (!quiet) setError('');
      return response;
    } catch (loadError) {
      if (sequence === requestSequence.current && !quiet) setError(messageOf(loadError));
      return null;
    }
  }, []);

  useEffect(() => {
    const remembered = sessionStorage.getItem('auto-page/active-ai-chat') || undefined;
    void loadHistory(remembered);
  }, [loadHistory]);

  const anyBusy = Boolean(busySessionId || localRun);
  useEffect(() => {
    if (!anyBusy) return;
    const timer = window.setInterval(() => void loadHistory(activeSessionId || undefined, true), 1100);
    return () => window.clearInterval(timer);
  }, [activeSessionId, anyBusy, loadHistory]);

  useEffect(() => {
    if (!runtime.agentResult || runtime.agentResult.runId === handledResultRunId.current) return;
    handledResultRunId.current = runtime.agentResult.runId;
    setBusySessionId((current) => current === runtime.agentResult?.sessionId ? null : current);
    setLocalRun((current) => current?.sessionId === runtime.agentResult?.sessionId ? null : current);
    setPendingMessage((current) => current?.sessionId === runtime.agentResult?.sessionId ? null : current);
    setAbortingSessionId((current) => current === runtime.agentResult?.sessionId ? null : current);
    if (runtime.agentResult.sessionId !== activeSessionId) return;
    void loadHistory(activeSessionId || undefined, true).then(() => {
      setLocalRun(null);
      setPendingMessage(null);
      if (!runtime.agentResult?.ok) setError(runtime.agentResult?.message || 'AI 助手处理失败');
    });
  }, [activeSessionId, loadHistory, runtime.agentResult]);

  const createSession = useCallback(async (): Promise<AgentChatSessionRecord | null> => {
    setCreating(true);
    setError('');
    try {
      const response = await request<{ session: AgentChatSessionRecord }>({ type: MSG.AGENT_CHAT_CREATE });
      setSession(response.session);
      setActiveSessionId(response.session.id);
      setPendingMessage(null);
      sessionStorage.setItem('auto-page/active-ai-chat', response.session.id);
      await loadHistory(response.session.id, true);
      setMobileSessionsOpen(false);
      return response.session;
    } catch (createError) {
      setError(messageOf(createError));
      return null;
    } finally {
      setCreating(false);
    }
  }, [loadHistory]);

  const selectSession = async (sessionId: string) => {
    if (sessionId === activeSessionId) { setMobileSessionsOpen(false); return; }
    setActiveSessionId(sessionId);
    setSession(null);
    setError('');
    setMobileSessionsOpen(false);
    await loadHistory(sessionId);
  };

  const clearSession = async (sessionId: string) => {
    if (busySessionId === sessionId || localRun?.sessionId === sessionId) return;
    if (!confirm('清空这个会话的全部消息？会话本身会保留。')) return;
    try {
      await request({ type: MSG.AGENT_CHAT_RESET, sessionId });
      await loadHistory(activeSessionId || sessionId);
      notify('对话内容已清空');
    } catch (clearError) { notify(messageOf(clearError), true); }
  };

  const deleteSession = async (sessionId: string) => {
    if (busySessionId === sessionId || localRun?.sessionId === sessionId) return;
    const target = sessions.find((item) => item.id === sessionId);
    if (!confirm(`删除会话“${target?.title || '新对话'}”？此操作无法撤销。`)) return;
    try {
      await request({ type: MSG.AGENT_CHAT_DELETE, sessionId });
      if (sessionId === activeSessionId) { setSession(null); setActiveSessionId(null); }
      await loadHistory(sessionId === activeSessionId ? undefined : activeSessionId || undefined);
      notify('会话已删除');
    } catch (deleteError) { notify(messageOf(deleteError), true); }
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || anyBusy) return;
    if (!settings.llmApiKey) { onOpenSettings(); return; }
    const target = session || await createSession();
    if (!target) return;
    const startedAt = Date.now();
    const optimisticTurn: ChatTurn = {
      id: `pending_${crypto.randomUUID()}`,
      role: 'user',
      text,
      at: startedAt,
    };
    setDraft('');
    setError('');
    setPendingMessage({ sessionId: target.id, turn: optimisticTurn });
    setLocalRun({ sessionId: target.id, startedAt });
    try {
      const response = await request<{ started: boolean; sessionId: string }>({ type: MSG.AGENT_CHAT_SEND, sessionId: target.id, text });
      setBusySessionId(response.sessionId);
      setLocalRun({ sessionId: response.sessionId, startedAt });
      await loadHistory(response.sessionId, true);
    } catch (sendError) {
      setPendingMessage(null);
      setLocalRun(null);
      setBusySessionId(null);
      setDraft(text);
      setError(messageOf(sendError));
    }
  };

  const abort = async () => {
    if (!activeSessionId || !isCurrentBusy || abortingSessionId === activeSessionId) return;
    setAbortingSessionId(activeSessionId);
    try {
      await request({ type: MSG.AGENT_CHAT_ABORT, sessionId: activeSessionId });
    } catch (abortError) {
      setAbortingSessionId(null);
      setError(messageOf(abortError));
    }
  };

  const isCurrentBusy = Boolean(activeSessionId && (busySessionId === activeSessionId || localRun?.sessionId === activeSessionId));
  const aborting = abortingSessionId === activeSessionId;
  const displayedPending = pendingMessage?.sessionId === activeSessionId ? pendingMessage.turn : null;
  const turns = session?.turns || [];
  const title = session?.title || '新对话';
  const sessionStatus = useMemo(() => {
    if (isCurrentBusy) return { label: aborting ? '正在停止' : '处理中', variant: 'warning' as const };
    if (session?.status === 'interrupted') return { label: '已中断', variant: 'destructive' as const };
    return { label: '已就绪', variant: 'success' as const };
  }, [aborting, isCurrentBusy, session?.status]);

  return <TooltipProvider delayDuration={300}>
    <div className="ai-chat-layout">
      {mobileSessionsOpen ? <button className="ai-chat-scrim" aria-label="关闭会话列表" onClick={() => setMobileSessionsOpen(false)} /> : null}
      <ConversationSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        busySessionId={busySessionId || localRun?.sessionId || null}
        mobileOpen={mobileSessionsOpen}
        creating={creating}
        onCreate={() => void createSession()}
        onSelect={(id) => void selectSession(id)}
        onClear={(id) => void clearSession(id)}
        onDelete={(id) => void deleteSession(id)}
        onCloseMobile={() => setMobileSessionsOpen(false)}
      />
      <section className="ai-chat-main" aria-label="AI 对话">
        <header className="ai-chat-header">
          <Button className="ai-chat-menu-trigger" variant="ghost" size="icon" onClick={() => setMobileSessionsOpen(true)} aria-label="打开会话列表"><Menu aria-hidden="true" /></Button>
          <span className="ai-chat-header-icon"><Bot aria-hidden="true" /></span>
          <div className="ai-chat-header-copy"><strong>{title}</strong><span>{settings.llmProvider === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'} · {settings.llmModel || '未选择模型'}</span></div>
          <Badge variant={sessionStatus.variant}>{sessionStatus.label}</Badge>
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={onOpenSettings} aria-label="打开 AI 设置"><Settings2 aria-hidden="true" /></Button></TooltipTrigger><TooltipContent>AI 设置</TooltipContent></Tooltip>
        </header>
        <ConversationTranscript
          turns={turns}
          pendingTurn={displayedPending}
          busy={isCurrentBusy}
          progress={isCurrentBusy && runtime.agentProgress?.sessionId === activeSessionId ? runtime.agentProgress.message : ''}
          error={error}
          apiConfigured={Boolean(settings.llmApiKey)}
          onUsePrompt={setDraft}
          onOpenSettings={onOpenSettings}
          onOpenEntity={onOpenEntity}
        />
        <ChatComposer
          value={draft}
          busy={isCurrentBusy}
          blocked={anyBusy && !isCurrentBusy}
          aborting={aborting}
          apiConfigured={Boolean(settings.llmApiKey)}
          onChange={setDraft}
          onSend={() => void submit()}
          onAbort={() => void abort()}
        />
      </section>
    </div>
  </TooltipProvider>;
}
