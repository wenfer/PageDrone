import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Send, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface ChatComposerProps {
  value: string;
  busy: boolean;
  blocked: boolean;
  aborting: boolean;
  apiConfigured: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onAbort: () => void;
}

export function ChatComposer({ value, busy, blocked, aborting, apiConfigured, onChange, onSend, onAbort }: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 44), 168)}px`;
  }, [value]);

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || composing || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (value.trim() && !busy && !blocked && apiConfigured) onSend();
  };

  return <footer className="ai-chat-composer">
    <div className="ai-chat-composer-box">
      <Textarea
        ref={textareaRef}
        rows={1}
        value={value}
        disabled={!apiConfigured}
        placeholder={!apiConfigured ? '请先在 AI 设置中保存 API Key' : blocked ? '另一会话正在处理，你可以先编辑下一条消息' : '输入消息，Enter 发送，Shift + Enter 换行'}
        aria-label="发送给 AI 助手的消息"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={keyDown}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
      {busy ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button className="ai-chat-send" variant="destructive" size="icon" disabled={aborting} onClick={onAbort} aria-label="停止 AI 助手">
              <Square aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{aborting ? '正在停止…' : '停止当前处理'}</TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button className="ai-chat-send" size="icon" disabled={blocked || !apiConfigured || !value.trim()} onClick={onSend} aria-label="发送消息">
              <Send aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>发送消息</TooltipContent>
        </Tooltip>
      )}
    </div>
    <div className="ai-chat-composer-meta">
      <span>AI 助手可能出错，请通过 AI 工具执行记录核验实际结果。</span>
      <span><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行</span>
    </div>
  </footer>;
}
