import { useState } from 'react';
import { ChevronDown, ChevronRight, FolderCog, Folder, Hash, KeyRound, MoreHorizontal, Pause, Plus, Users } from 'lucide-react';
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NewRoomDialog } from '@/components/dialogs/NewRoomDialog';
import { JoinRoomDialog } from '@/components/dialogs/JoinRoomDialog';
import { GroupManagerDialog } from '@/components/dialogs/GroupManagerDialog';
import { cn } from '@/lib/utils';
import { formatTime } from '@/lib/format';
import { log } from '@/lib/logger';
import type { RoomSummary } from '@/lib/types';

/** 未分组那一堆在折叠状态里用的"伪分组 id" */
const UNGROUPED = '__ungrouped__';

export function RoomList({ onNavigate }: { onNavigate?: () => void } = {}) {
  const { rooms, groups, activeRoomId, openRoom, moveRoomToGroup, createGroup, reorderGroups } = useChatStore();
  const pushToast = useUiStore((s) => s.pushToast);
  const collapsedGroups = useUiStore((s) => s.collapsedGroups);
  const toggleGroupCollapsed = useUiStore((s) => s.toggleGroupCollapsed);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);
  /** 拖拽中：dragPayload 记住正在拖的是分组还是房间 */
  const [dragPayload, setDragPayload] = useState<{ kind: 'group' | 'room'; id: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  /** 分组换序：把 fromId 挪到 toId 的位置，提交整串新顺序 */
  const dropGroupOn = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const ids = groups.map((g) => g.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void reorderGroups(ids).catch((err) =>
      pushToast(err instanceof Error ? err.message : String(err), 'error'),
    );
  };

  const select = async (roomId: string) => {
    log.action('切换房间', roomId);
    try {
      await openRoom(roomId);
      onNavigate?.();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  /** 分组 → 房间（保持 sort 顺序；只保留看得见且有房间的分组） */
  const knownGroupIds = new Set(groups.map((g) => g.id));
  const buckets: Array<{ id: string; name: string; rooms: RoomSummary[] }> = groups
    .map((g) => ({ id: g.id, name: g.name, rooms: rooms.filter((r) => r.groupId === g.id) }))
    .filter((bucket) => bucket.rooms.length > 0);
  const ungrouped = rooms.filter((r) => !r.groupId || !knownGroupIds.has(r.groupId));
  if (ungrouped.length) buckets.push({ id: UNGROUPED, name: '未分组', rooms: ungrouped });
  // 一个分组都没有时，保持原来的平铺列表（不显示多余的「未分组」标题）
  const showHeaders = groups.length > 0;
  const flatRooms = !showHeaders ? rooms : [];

  const renderRoom = (room: RoomSummary) => {
    const active = room.id === activeRoomId;
    const last = room.lastMessage;
    return (
      <div
        key={room.id}
        role="button"
        tabIndex={0}
        draggable
        onDragStart={(e) => {
          setDragPayload({ kind: 'room', id: room.id });
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', room.id);
        }}
        onDragEnd={() => {
          setDragPayload(null);
          setDropTarget(null);
        }}
        onClick={() => void select(room.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') void select(room.id);
        }}
        className={cn(
          'group/room mb-1 flex w-full cursor-pointer flex-col gap-1 rounded-lg px-3 py-2 text-left transition-colors',
          active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
        )}
      >
        <span className="flex items-center gap-2">
          <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{room.name}</span>
          {room.paused && <Pause className="h-3 w-3 shrink-0 text-amber-500" />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title="移动到分组"
                onClick={(e) => e.stopPropagation()}
                className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover/room:opacity-100"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuLabel>移动到分组</DropdownMenuLabel>
              {groups.map((g) => (
                <DropdownMenuItem
                  key={g.id}
                  disabled={room.groupId === g.id}
                  onClick={() =>
                    void moveRoomToGroup(room.id, g.id)
                      .then(() => pushToast(`「${room.name}」已移到「${g.name}」`, 'success'))
                      .catch((err) => pushToast(err instanceof Error ? err.message : String(err), 'error'))
                  }
                >
                  <Folder className="h-3 w-3" />
                  {g.name}
                </DropdownMenuItem>
              ))}
              {Boolean(room.groupId) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() =>
                      void moveRoomToGroup(room.id, null)
                        .then(() => pushToast(`「${room.name}」已移出分组`, 'success'))
                        .catch((err) => pushToast(err instanceof Error ? err.message : String(err), 'error'))
                    }
                  >
                    移出分组
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  const name = window.prompt('新分组名（会把这个群放进去）');
                  if (!name?.trim()) return;
                  void createGroup(name.trim())
                    .then((g) => moveRoomToGroup(room.id, g.id))
                    .then(() => pushToast(`已新建分组「${name.trim()}」并移入`, 'success'))
                    .catch((err) => pushToast(err instanceof Error ? err.message : String(err), 'error'));
                }}
              >
                <Plus className="h-3 w-3" />
                新建分组并移入…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
      </div>
    );
  };

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-r bg-muted/30 md:w-64">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">群聊房间</span>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setGroupManagerOpen(true)} title="群聊分组">
            <FolderCog className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setJoinOpen(true)} title="用邀请码加入群聊">
            <KeyRound className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setDialogOpen(true)} title="新建群聊">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!rooms.length && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            还没有房间。点右上角「+」建一个群聊，或点钥匙图标用邀请码加入别人建的群。
          </p>
        )}

        {flatRooms.map(renderRoom)}

        {buckets.map((bucket) => {
          const collapsed = collapsedGroups.includes(bucket.id);
          const isGroupBucket = bucket.id !== UNGROUPED;
          const isDropTarget = dropTarget === bucket.id;
          return (
            <div
              key={bucket.id}
              className={cn('mb-1 rounded-md transition-colors', isDropTarget && 'bg-primary/10 ring-1 ring-primary/40')}
              onDragOver={(e) => {
                // 拖分组 = 换序；拖房间 = 挪进这个分组（未分组那个桶就是挪出去）
                if (!dragPayload) return;
                if (dragPayload.kind === 'group' && !isGroupBucket) return;
                e.preventDefault();
                setDropTarget(bucket.id);
              }}
              onDragLeave={() => setDropTarget((cur) => (cur === bucket.id ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                setDropTarget(null);
                if (!dragPayload) return;
                if (dragPayload.kind === 'group' && isGroupBucket) dropGroupOn(dragPayload.id, bucket.id);
                if (dragPayload.kind === 'room') {
                  void moveRoomToGroup(dragPayload.id, isGroupBucket ? bucket.id : null)
                    .then(() => pushToast(isGroupBucket ? `已移入「${bucket.name}」` : '已移出分组', 'success'))
                    .catch((err) => pushToast(err instanceof Error ? err.message : String(err), 'error'));
                }
                setDragPayload(null);
              }}
            >
              <button
                type="button"
                draggable={isGroupBucket}
                onDragStart={(e) => {
                  if (!isGroupBucket) return;
                  setDragPayload({ kind: 'group', id: bucket.id });
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', bucket.id);
                }}
                onDragEnd={() => {
                  setDragPayload(null);
                  setDropTarget(null);
                }}
                onClick={() => toggleGroupCollapsed(bucket.id)}
                /* 不强制大写：分组名是用户自己起的，AgentHub 就该显示成 AgentHub 而不是 AGENTHUB */
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-medium tracking-wide text-muted-foreground transition-colors hover:bg-accent/50"
                title={
                  isGroupBucket
                    ? `${collapsed ? '展开' : '折叠'}（拖动可换分组顺序；把房间拖到这里可移入本组）`
                    : '把房间拖到这里可移出分组'
                }
              >
                {collapsed ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
                <Folder className="h-3 w-3 shrink-0" />
                <span className="truncate">{bucket.name}</span>
                <span className="ml-auto shrink-0">{bucket.rooms.length}</span>
              </button>
              {!collapsed && (
                <div className="mt-0.5 ml-2 border-l border-border/60 pl-1">{bucket.rooms.map(renderRoom)}</div>
              )}
            </div>
          );
        })}
      </div>

      <NewRoomDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <JoinRoomDialog open={joinOpen} onOpenChange={setJoinOpen} />
      <GroupManagerDialog open={groupManagerOpen} onOpenChange={setGroupManagerOpen} />
    </aside>
  );
}
