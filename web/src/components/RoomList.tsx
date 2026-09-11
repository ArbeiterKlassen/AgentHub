import { useState } from 'react';
import { Hash, Pause, Plus, Users } from 'lucide-react';
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { NewRoomDialog } from '@/components/dialogs/NewRoomDialog';
import { cn } from '@/lib/utils';
import { formatTime } from '@/lib/format';
import { log } from '@/lib/logger';

export function RoomList({ onNavigate }: { onNavigate?: () => void } = {}) {
  const { rooms, activeRoomId, openRoom } = useChatStore();
  const pushToast = useUiStore((s) => s.pushToast);
  const [dialogOpen, setDialogOpen] = useState(false);

  const select = async (roomId: string) => {
    log.action('切换房间', roomId);
    try {
      await openRoom(roomId);
      onNavigate?.();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-r bg-muted/30 md:w-64">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">群聊房间</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setDialogOpen(true)} title="新建群聊">
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!rooms.length && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            还没有房间。点右上角「+」建一个群聊，然后把 AI 成员拉进来。
          </p>
        )}
        {rooms.map((room) => {
          const active = room.id === activeRoomId;
          const last = room.lastMessage;
          return (
            <button
              key={room.id}
              type="button"
              onClick={() => void select(room.id)}
              className={cn(
                'mb-1 flex w-full flex-col gap-1 rounded-lg px-3 py-2 text-left transition-colors',
                active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
              )}
            >
              <span className="flex items-center gap-2">
                <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-medium">{room.name}</span>
                {room.paused && <Pause className="h-3 w-3 shrink-0 text-amber-500" />}
              </span>
              <span className="flex items-center gap-2 pl-5 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-0.5">
                  <Users className="h-3 w-3" />
                  {room.memberCount}
                </span>
                <span className="truncate">
                  {last ? `${last.senderKind === 'agent' ? '🤖 ' : ''}${String(last.text).slice(0, 16)}` : '暂无消息'}
                </span>
                {last && <span className="ml-auto shrink-0">{formatTime(last.createdAt)}</span>}
              </span>
            </button>
          );
        })}
      </div>

      <NewRoomDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </aside>
  );
}
