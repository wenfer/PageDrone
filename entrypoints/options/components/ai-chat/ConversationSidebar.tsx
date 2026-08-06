import { useMemo, useState } from 'react';
import { Clock3, MoreHorizontal, Plus, Search, Trash2, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AgentChatSessionSummary } from '../../../../src/lib/types.js';
import { formatConversationTime } from './utils';

interface ConversationSidebarProps {
  sessions: AgentChatSessionSummary[];
  activeSessionId: string | null;
  busySessionId: string | null;
  mobileOpen: boolean;
  creating: boolean;
  onCreate: () => void;
  onSelect: (sessionId: string) => void;
  onClear: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onCloseMobile: () => void;
}

export function ConversationSidebar({
  sessions,
  activeSessionId,
  busySessionId,
  mobileOpen,
  creating,
  onCreate,
  onSelect,
  onClear,
  onDelete,
  onCloseMobile,
}: ConversationSidebarProps) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return sessions;
    return sessions.filter((session) => `${session.title} ${session.preview}`.toLocaleLowerCase().includes(normalized));
  }, [query, sessions]);

  return (
    <aside className={`ai-chat-sessions${mobileOpen ? ' mobile-open' : ''}`} aria-label="AI 对话会话历史">
      <div className="ai-chat-sessions-head">
        <div>
          <span className="ai-chat-kicker">AI 对话</span>
          <strong>会话历史</strong>
        </div>
        <Button className="ai-chat-mobile-close" variant="ghost" size="icon" onClick={onCloseMobile} aria-label="关闭会话列表">
          <X aria-hidden="true" />
        </Button>
      </div>
      <Button className="ai-chat-new" onClick={onCreate} disabled={creating}>
        <Plus aria-hidden="true" />{creating ? '正在创建…' : '新建对话'}
      </Button>
      <label className="ai-chat-search">
        <Search aria-hidden="true" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" aria-label="搜索会话" />
      </label>
      <ScrollArea className="ai-chat-session-scroll">
        <div className="ai-chat-session-list">
          {filtered.map((session) => {
            const active = session.id === activeSessionId;
            const busy = session.id === busySessionId;
            return (
              <div className={`ai-chat-session-row${active ? ' active' : ''}`} key={session.id}>
                <button type="button" className="ai-chat-session-main" aria-current={active ? 'page' : undefined} onClick={() => onSelect(session.id)}>
                  <span className="ai-chat-session-title">
                    <strong>{session.title || '新对话'}</strong>
                    {busy ? <span className="ai-chat-running-dot" title="AI 助手处理中" /> : null}
                  </span>
                  <span className="ai-chat-session-preview">{session.preview || '还没有消息'}</span>
                  <span className="ai-chat-session-meta"><Clock3 aria-hidden="true" />{formatConversationTime(session.updatedAt)} · {session.turnCount} 条</span>
                </button>
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button className="ai-chat-session-menu" variant="ghost" size="icon" aria-label={`管理会话 ${session.title}`}>
                          <MoreHorizontal aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>会话操作</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={busy} onSelect={() => onClear(session.id)}>
                      <RotateCcw aria-hidden="true" />清空内容
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="ai-chat-destructive-item" disabled={busy} onSelect={() => onDelete(session.id)}>
                      <Trash2 aria-hidden="true" />删除会话
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
          {!filtered.length ? <div className="ai-chat-session-empty">{sessions.length ? '没有匹配的会话' : '还没有历史会话'}</div> : null}
        </div>
      </ScrollArea>
      <div className="ai-chat-session-foot">
        <Badge variant="outline">本机持久保存</Badge>
        <span>删除会话不会影响已创建的技能</span>
      </div>
    </aside>
  );
}
