import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerUpLeft, Download, Loader2, Search } from 'lucide-react';
import { downloadRoomExport } from '@/lib/api';
import { useSessionStore } from '@/stores/session';
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDateTime } from '@/lib/format';
import { log } from '@/lib/logger';
import type { ChatMessage } from '@/lib/types';

interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string | null;
}

/** 房间消息搜索 + 聊天记录导出 */
export function SearchDialog({ open, onOpenChange, roomId }: SearchDialogProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ChatMessage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchMessages = useChatStore((s) => s.searchMessages);
  const jumpToMessage = useChatStore((s) => s.jumpToMessage);
  const members = useChatStore((s) => (roomId ? (s.members[roomId] ?? []) : []));
  const pushToast = useUiStore((s) => s.pushToast);
  const server = useSessionStore((s) => s.server);
  const inputRef = useRef<HTMLInputElement>(null);

  const room = useChatStore((s) => s.rooms.find((r) => r.id === roomId));
  const memberByTag = useMemo(() => new Map(members.map((m) => [m.tag, m])), [members]);

  useEffect(() => {
    if (open) {
      setError(null);
      window.setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !roomId) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setHits(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    const timer = window.setTimeout(() => {
      searchMessages(roomId, trimmed)
        .then((list) => setHits(list))
        .catch((err: unknown) => {
          setHits([]);
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setBusy(false));
    }, 280);
    return () => window.clearTimeout(timer);
  }, [open, roomId, query, searchMessages]);

  if (!open || !roomId) return null;

  const onJump = async (message: ChatMessage) => {
    try {
      await jumpToMessage(roomId, message.id);
      onOpenChange(false);
      log.action('搜索定位消息', String(message.id));
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const download = (format: 'md' | 'json') => {
    downloadRoomExport(server, roomId, room?.name ?? roomId, format, {
      search: query.trim() || undefined,
      limit: 5000,
    });
    pushToast(query.trim() ? `已导出匹配「${query.trim()}」的记录` : '已开始导出聊天记录', 'success');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[8vh]">
      <button type="button" className="absolute inset-0" aria-label="关闭搜索" onClick={() => onOpenChange(false)} />
      <div className="relative flex max-h-[76vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-background shadow-xl">
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`在「${room?.name ?? '本群'}」里搜索消息内容…`}
            className="border-0 px-0 shadow-none focus-visible:ring-0"
          />
          {busy && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
          <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={() => onOpenChange(false)}>
            Esc
          </Button>
        </div>

        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
          {error && <p className="p-4 text-sm text-destructive">{error}</p>}
          {!error && hits === null && (
            <p className="p-4 text-sm text-muted-foreground">
              输入关键词后回车即搜（服务端全文检索，能搜到本地没加载的更早记录）。
            </p>
          )}
          {!error && hits?.length === 0 && !busy && (
            <p className="p-4 text-sm text-muted-foreground">没有匹配「{query.trim()}」的消息。</p>
          )}
          {hits?.map((message) => {
            const member = memberByTag.get(message.senderTag);
            return (
              <div key={message.id} className="mb-1.5 rounded-lg border bg-card p-2.5">
                <div className="flex items-center gap-2">
                  {member ? (
                    <Avatar member={member} size="sm" />
                  ) : (
                    <span className="text-sm">{message.senderKind === 'system' ? '⚙️' : '💬'}</span>
                  )}
                  <span className="truncate text-xs font-medium">{message.senderNickname}</span>
                  <span className="text-[11px] text-muted-foreground">{formatDateTime(message.createdAt)}</span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">#{message.id}</span>
                  <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={() => void onJump(message)}>
                    <CornerUpLeft className="mr-0.5 h-3 w-3" />
                    定位
                  </Button>
                </div>
                <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap break-words text-sm">{message.text}</p>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
          <span>导出本群聊天记录：</span>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => download('md')}>
            <Download className="mr-1 h-3 w-3" />
            Markdown
          </Button>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => download('json')}>
            <Download className="mr-1 h-3 w-3" />
            JSON
          </Button>
          <span className="ml-auto">{query.trim() ? '含搜索词时只导出匹配的消息' : '最多 5000 条'}</span>
        </div>
      </div>
    </div>
  );
}
