import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Loader2, MessagesSquare, Sparkles } from 'lucide-react';
import type { ChatMessage, Member, SharedFile } from '@/lib/types';
import { MessageItem } from '@/components/MessageItem';
import { Button } from '@/components/ui/button';
import { formatDay } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { apiClient } from '@/lib/api';
import { log } from '@/lib/logger';

interface MessageListProps {
  roomId: string;
  messages: ChatMessage[];
  members: Member[];
  files: SharedFile[];
  typing: Array<{ tag: string; nickname: string }>;
  /** 搜索里点了「定位」的消息 id：滚过去并短暂高亮 */
  focusMessageId?: number | null;
  onFocusHandled?: () => void;
  onReply: (message: ChatMessage) => void;
  onDelete: (message: ChatMessage) => void;
}

export function MessageList({
  roomId,
  messages,
  members,
  files,
  typing,
  focusMessageId,
  onFocusHandled,
  onReply,
  onDelete,
}: MessageListProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlier, setEarlier] = useState<ChatMessage[]>([]);
  const [flashId, setFlashId] = useState<number | null>(null);
  const handledFocus = useRef<number | null>(null);

  const all = useMemo(() => {
    const map = new Map<number, ChatMessage>();
    for (const m of [...earlier, ...messages]) map.set(m.id, m);
    return [...map.values()].sort((a, b) => a.id - b.id);
  }, [earlier, messages]);

  const byId = useMemo(() => new Map(all.map((m) => [m.id, m])), [all]);

  useEffect(() => {
    setEarlier([]);
  }, [roomId]);

  useEffect(() => {
    if (!atBottom) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [all.length, typing.length, atBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [roomId]);

  /* 搜索定位：等这条消息渲染出来再滚动（jumpToMessage 会先把上下文并进列表） */
  useEffect(() => {
    if (!focusMessageId || handledFocus.current === focusMessageId) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${focusMessageId}"]`);
    if (!el) return;
    handledFocus.current = focusMessageId;
    setAtBottom(false);
    el.scrollIntoView({ block: 'center' });
    setFlashId(focusMessageId);
    onFocusHandled?.();
    const timer = window.setTimeout(() => setFlashId(null), 2600);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMessageId, all.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance < 120);
  };

  const loadEarlier = async () => {
    const first = all[0];
    if (!first) return;
    setLoadingEarlier(true);
    try {
      const res = await apiClient.messages(roomId, { before: first.id, limit: 50 });
      const el = scrollRef.current;
      const previousHeight = el?.scrollHeight ?? 0;
      setEarlier((prev) => [...res.messages, ...prev]);
      window.requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - previousHeight;
      });
      log.debug('加载更早的消息', res.messages.length);
    } finally {
      setLoadingEarlier(false);
    }
  };

  if (!all.length) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md space-y-3 text-center">
          <MessagesSquare className="mx-auto h-10 w-10 text-muted-foreground/60" />
        <h3 className="text-base font-semibold">{t('messages.emptyTitle')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('messages.emptyHintBefore')} <span className="mention-chip">@</span> {t('messages.emptyHintAfter')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('messages.emptyCommands')}
        </p>
        </div>
      </div>
    );
  }

  let lastDay = '';
  return (
    <div ref={scrollRef} onScroll={onScroll} className="thin-scrollbar relative min-h-0 flex-1 overflow-y-auto py-3">
      <div className="mx-auto max-w-4xl">
        <div className="mb-2 flex justify-center">
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => void loadEarlier()} disabled={loadingEarlier}>
            {loadingEarlier ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowDown className="h-3 w-3 rotate-180" />}
            {t('messages.loadEarlier')}
          </Button>
        </div>

        {all.map((message) => {
          const day = formatDay(message.createdAt);
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <div
              key={message.id}
              data-message-id={message.id}
              className={cn(
                'rounded-lg transition-colors',
                flashId === message.id && 'bg-primary/10 ring-1 ring-primary/40',
              )}
            >
              {showDay && (
                <div className="my-3 flex justify-center">
                  <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] text-muted-foreground">{day}</span>
                </div>
              )}
              <MessageItem
                message={message}
                members={members}
                files={files}
                replyTo={message.replyTo ? (byId.get(message.replyTo) ?? null) : null}
                onReply={onReply}
                onDelete={onDelete}
              />
            </div>
          );
        })}

        {typing.map((item) => (
          <div key={item.tag} className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <span className="font-medium">{item.nickname}</span>
            <span>{t('messages.thinking')}</span>
            <span className="flex gap-0.5">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </span>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => {
          const el = scrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
          setAtBottom(true);
        }}
        className={cn(
          'sticky bottom-2 left-full mr-4 flex h-8 w-8 items-center justify-center rounded-full border bg-background shadow transition-opacity',
          atBottom ? 'pointer-events-none opacity-0' : 'opacity-100',
        )}
        title={t('messages.jumpToLatest')}
      >
        <ArrowDown className="h-4 w-4" />
      </button>
    </div>
  );
}
