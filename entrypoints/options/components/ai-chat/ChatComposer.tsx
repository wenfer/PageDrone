import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronRight, Command, Send, Square } from 'lucide-react';
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

interface QuickCommand {
  id: string;
  label: string;
  description: string;
  /** 输入框中展示的短命令；用户可以继续补充目标或上下文。 */
  insert: string;
  aliases: string[];
}

/**
 * These are lightweight slash-command shortcuts, rather than a second AI tool
 * registry. The visible text stays compact and user-editable; sending still
 * uses the normal AGENT_CHAT_SEND path and the agent maps the command to its
 * normal tool workflow.
 */
const QUICK_COMMANDS: QuickCommand[] = [
  {
    id: 'inspect-skill',
    label: '检查技能',
    description: '检查技能配置和最近执行结果',
    insert: '/检查技能 ',
    aliases: ['技能', '配置', '检查'],
  },
  {
    id: 'read-skill',
    label: '查看技能详情',
    description: '读取步骤、判定条件和返回值',
    insert: '/查看技能 ',
    aliases: ['详情', '步骤', '读取技能'],
  },
  {
    id: 'repair-skill',
    label: '修复技能',
    description: '根据日志定位问题并复核修复结果',
    insert: '/修复技能 ',
    aliases: ['修复', '诊断', '排查'],
  },
  {
    id: 'test-skill',
    label: '测试技能',
    description: '真实执行并观察每一步页面变化',
    insert: '/测试技能 ',
    aliases: ['测试技能', '页面诊断', '验证技能'],
  },
  {
    id: 'test-flow',
    label: '测试流程',
    description: '复用正式画布引擎执行并分析流程',
    insert: '/测试流程 ',
    aliases: ['测试流程', '流程诊断', '验证流程'],
  },
  {
    id: 'list-sites',
    label: '查看站点',
    description: '列出站点及其绑定的技能',
    insert: '/查看站点 ',
    aliases: ['站点', '网站'],
  },
  {
    id: 'read-logs',
    label: '查看执行日志',
    description: '总结最近的执行成功与失败原因',
    insert: '/查看日志 ',
    aliases: ['日志', '执行记录', '失败'],
  },
  {
    id: 'read-page',
    label: '读取当前页面',
    description: '观察当前标签页可交互内容',
    insert: '/读取页面 ',
    aliases: ['页面', '浏览器', '探索'],
  },
  {
    id: 'create-skill',
    label: '创建技能',
    description: '从网址和目标开始创建网页技能',
    insert: '/创建技能 ',
    aliases: ['新建', '创建', '自动化'],
  },
];

const COMMAND_TRIGGER = /^\s*\/([^\s]*)$/;

export function ChatComposer({ value, busy, blocked, aborting, apiConfigured, onChange, onSend, onAbort }: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [composing, setComposing] = useState(false);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);

  const commandMatch = value.match(COMMAND_TRIGGER);
  const commandQuery = commandMatch?.[1]?.toLocaleLowerCase() ?? null;
  const commandSuggestions = commandQuery === null
    ? []
    : QUICK_COMMANDS.filter((command) => {
      if (!commandQuery) return true;
      const searchText = [command.label, command.description, ...command.aliases].join(' ').toLocaleLowerCase();
      return searchText.includes(commandQuery);
    });
  const commandMenuOpen = apiConfigured && !commandMenuDismissed && commandSuggestions.length > 0;

  useEffect(() => {
    if (commandQuery === null) setCommandMenuDismissed(false);
  }, [commandQuery]);

  useEffect(() => {
    setActiveCommandIndex((index) => Math.min(index, Math.max(commandSuggestions.length - 1, 0)));
  }, [commandQuery, commandSuggestions.length]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 44), 168)}px`;
  }, [value]);

  const useCommand = (command: QuickCommand) => {
    setCommandMenuDismissed(true);
    const nextValue = command.insert;
    onChange(nextValue);
    setActiveCommandIndex(0);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(nextValue.length, nextValue.length);
    });
  };

  const useQuickCommand = (command: QuickCommand) => {
    setCommandMenuDismissed(true);
    const existing = value.trim();
    const nextValue = existing ? `${value.trimEnd()}\n\n${command.insert}` : command.insert;
    onChange(nextValue);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(nextValue.length, nextValue.length);
    });
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!composing && !event.nativeEvent.isComposing && commandMenuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveCommandIndex((index) => (index + 1) % commandSuggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveCommandIndex((index) => (index - 1 + commandSuggestions.length) % commandSuggestions.length);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setCommandMenuDismissed(true);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const command = commandSuggestions[activeCommandIndex] ?? commandSuggestions[0];
        if (command) useCommand(command);
        return;
      }
    }
    if (event.key !== 'Enter' || event.shiftKey || composing || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (value.trim() && !busy && !blocked && apiConfigured) onSend();
  };

  return <footer className="ai-chat-composer">
    <div className="ai-chat-command-bar" aria-label="AI 对话快捷命令">
      <span className="ai-chat-command-label"><Command aria-hidden="true" /><span>快捷命令</span></span>
      <div className="ai-chat-command-list">
        {QUICK_COMMANDS.map((command) => <Button key={command.id} type="button" className="ai-chat-command-chip" variant="outline" size="sm" disabled={!apiConfigured} title={command.description} onClick={() => useQuickCommand(command)}>{command.label}</Button>)}
      </div>
      <span className="ai-chat-command-hint">输入 <kbd>/</kbd> 搜索</span>
    </div>
    <div className="ai-chat-composer-controls">
      {commandMenuOpen ? <div id="ai-chat-command-menu" className="ai-chat-command-menu" role="listbox" aria-label="命令建议">
        {commandSuggestions.map((command, index) => <button
          type="button"
          role="option"
          aria-selected={index === activeCommandIndex}
          className={`ai-chat-command-option${index === activeCommandIndex ? ' active' : ''}`}
          key={command.id}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => useCommand(command)}
        >
          <span className="ai-chat-command-option-icon"><Command aria-hidden="true" /></span>
          <span className="ai-chat-command-option-copy"><strong>/{command.label}</strong><small>{command.description}</small></span>
          {index === activeCommandIndex ? <Check aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        </button>)}
      </div> : null}
      <div className="ai-chat-composer-box">
        <Textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={!apiConfigured}
          placeholder={!apiConfigured ? '请先在 AI 设置中保存 API Key' : blocked ? '另一会话正在处理，你可以先编辑下一条消息' : '输入消息，Enter 发送，Shift + Enter 换行'}
          aria-label="发送给 AI 助手的消息"
          aria-autocomplete="list"
          aria-controls={commandMenuOpen ? 'ai-chat-command-menu' : undefined}
          aria-expanded={commandMenuOpen}
          onChange={(event) => {
            setCommandMenuDismissed(false);
            onChange(event.target.value);
          }}
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
              <Button className="ai-chat-send" size="icon" disabled={blocked || !apiConfigured || !value.trim() || commandMenuOpen} onClick={onSend} aria-label="发送消息">
                <Send aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>发送消息</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
    <div className="ai-chat-composer-meta">
      <span>AI 助手可能出错，请通过 AI 工具执行记录核验实际结果。</span>
      <span><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行</span>
    </div>
  </footer>;
}
