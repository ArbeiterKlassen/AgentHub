import { useEffect, useMemo, useState } from 'react';
import { Hash, KeyRound, Loader2, Menu, Pause, Play, Plus, Search, StopCircle, Upload, Users } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { useChatStore } from '@/stores/chat';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import { useRealtime } from '@/hooks/useRealtime';
import { RoomList } from '@/components/RoomList';
import { RightPanel } from '@/components/RightPanel';
import { MessageList } from '@/components/MessageList';
import { Composer } from '@/components/Composer';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/ui/button';
import { NewRoomDialog } from '@/components/dialogs/NewRoomDialog';
import { AddMemberDialog } from '@/components/dialogs/AddMemberDialog';
import { JoinRoomDialog } from '@/components/dialogs/JoinRoomDialog';
import { SearchDialog } from '@/components/dialogs/SearchDialog';
import { cn } from '@/lib/utils';
import { log } from '@/lib/logger';
import type { ChatMessage } from '@/lib/types';

export function ChatPage() {
  useRealtime();
  const {
    rooms,
    activeRoomId,
    messages,
    members,
    files,
    typing,
    focusMessageId,
    loadRooms,
    openRoom,
    removeMessage,
    upload,
    control,
    clearFocus,
  } = useChatStore();
  const token = useSessionStore((s) => s.token);
  const { rightPanelOpen, pushToast } = useUiStore();
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const [joinRoomOpen, setJoinRoomOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  // 手机端：房间列表 / 成员面板都做成抽屉，桌面端仍然常驻
  const [roomDrawerOpen, setRoomDrawerOpen] = useState(false);
  const [panelDrawerOpen, setPanelDrawerOpen] = useState(false);

  const room = rooms.find((r) => r.id === activeRoomId) ?? null;
  const roomMessages = useMemo(() => (activeRoomId ? (messages[activeRoomId] ?? []) : []), [activeRoomId, messages]);
  const roomMembers = useMemo(() => (activeRoomId ? (members[activeRoomId] ?? []) : []), [activeRoomId, members]);
  const roomFiles = useMemo(() => (activeRoomId ? (files[activeRoomId] ?? []) : []), [activeRoomId, files]);
  const roomTyping = useMemo(() => (activeRoomId ? (typing[activeRoomId] ?? []) : []), [activeRoomId, typing]);

  useEffect(() => {
    if (!token) return;
    void loadRooms()
      .then((list) => {
        if (!useChatStore.getState().activeRoomId && list.length) {
          void openRoom(list[0].id);
        }
      })
      .catch((err) => pushToast(err instanceof Error ? err.message : String(err), 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const dropped = Array.from(event.dataTransfer.files);
    if (!dropped.length || !activeRoomId) return;
    for (const file of dropped) {
      try {
        await upload(file);
        pushToast(`已上传 ${file.name}`, 'success');
      } catch (err) {
        pushToast(err instanceof Error ? err.message : String(err), 'error');
      }
    }
  };

  const onDelete = async (message: ChatMessage) => {
    try {
      await removeMessage(message.id);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <div
      className="flex h-full"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="hidden md:flex">
        <RoomList />
      </div>

      <main className="relative flex min-w-0 flex-1 flex-col">
        {!activeRoomId ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <Hash className="h-10 w-10 text-muted-foreground/50" />
            <h2 className="text-lg font-semibold">还没有加入任何房间</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              创建一个群聊房间，把 AI 成员拉进来，然后直接 @ 它们提问。AI 之间也可以互相 @ 接力讨论。
            </p>
            <Button onClick={() => setNewRoomOpen(true)}>
              <Plus className="mr-1 h-4 w-4" />
              新建群聊房间
            </Button>
            <Button variant="outline" onClick={() => setJoinRoomOpen(true)}>
              <KeyRound className="mr-1 h-4 w-4" />
              用邀请码加入群聊
            </Button>
            <NewRoomDialog open={newRoomOpen} onOpenChange={setNewRoomOpen} />
            <JoinRoomDialog open={joinRoomOpen} onOpenChange={setJoinRoomOpen} />
          </div>
        ) : (
          <>
            {/* 手机端顶栏：房间抽屉 + 标题 + 成员面板 */}
            <div className="flex shrink-0 items-center gap-1 border-b px-1.5 py-1.5 md:hidden">
              <Button variant="ghost" size="icon" onClick={() => setRoomDrawerOpen(true)} title="房间列表">
                <Menu className="h-5 w-5" />
              </Button>
              <div className="min-w-0 flex-1 px-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-semibold">{room?.name ?? '房间'}</span>
                  {room?.paused && <Pause className="h-3 w-3 shrink-0 text-amber-500" />}
                  {roomTyping.length > 0 && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />}
                </div>
                <p className="truncate text-[11px] text-muted-foreground">
                  {room?.memberCount ?? 0} 人 · {room?.messageCount ?? 0} 条消息
                </p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setPanelDrawerOpen(true)} title="成员 / 文件 / AI">
                <Users className="h-5 w-5" />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => setSearchOpen(true)} title="搜索消息 / 导出记录">
                <Search className="h-5 w-5" />
              </Button>
            </div>

            <div className="hidden h-14 shrink-0 items-center gap-3 border-b px-4 md:flex">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-semibold">{room?.name ?? '房间'}</h2>
                  {room?.paused && (
                    <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
                      <Pause className="h-2.5 w-2.5" />
                      已暂停接力
                    </span>
                  )}
                  {roomTyping.length > 0 && (
                    <span className="flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      {roomTyping.length} 个 AI 正在思考
                    </span>
                  )}
                </div>
                <p className="truncate text-[11px] text-muted-foreground">
                  {room?.topic || `创建者 @${room?.createdBy ?? '-'}`} · {room?.messageCount ?? 0} 条消息
                </p>
              </div>

              <div className="ml-auto flex items-center gap-1.5">
                <div className="mr-1 hidden items-center lg:flex">
                  {roomMembers.slice(0, 5).map((member) => (
                    <Avatar key={member.tag} member={member} size="sm" className="-ml-1.5 first:ml-0" showPresence online={member.online} />
                  ))}
                  {roomMembers.length > 5 && (
                    <span className="ml-1 text-[11px] text-muted-foreground">+{roomMembers.length - 5}</span>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  title="搜索消息 / 导出聊天记录"
                  onClick={() => setSearchOpen(true)}
                >
                  <Search className="h-3.5 w-3.5" />
                </Button>
                <Button variant="outline" size="sm" onClick={() => setAddMemberOpen(true)}>
                  <Users className="mr-1 h-3.5 w-3.5" />
                  拉人/拉 AI
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      await control(room?.paused ? 'resume' : 'pause');
                      log.action('切换接力状态', room?.paused ? 'resume' : 'pause');
                    } catch (err) {
                      pushToast(err instanceof Error ? err.message : String(err), 'error');
                    }
                  }}
                >
                  {room?.paused ? <Play className="mr-1 h-3.5 w-3.5" /> : <Pause className="mr-1 h-3.5 w-3.5" />}
                  {room?.paused ? '恢复' : '暂停'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  title="清空排队任务并暂停接力"
                  onClick={async () => {
                    try {
                      await control('stop');
                      pushToast('已停止排队中的 AI 任务', 'success');
                    } catch (err) {
                      pushToast(err instanceof Error ? err.message : String(err), 'error');
                    }
                  }}
                >
                  <StopCircle className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <MessageList
              roomId={activeRoomId}
              messages={roomMessages}
              members={roomMembers}
              files={roomFiles}
              typing={roomTyping}
              focusMessageId={focusMessageId}
              onFocusHandled={clearFocus}
              onReply={(message) => setReplyTo(message)}
              onDelete={(message) => void onDelete(message)}
            />

            <Composer
              roomId={activeRoomId}
              members={roomMembers}
              replyTo={replyTo ? { id: replyTo.id, text: replyTo.text, senderNickname: replyTo.senderNickname } : null}
              onClearReply={() => setReplyTo(null)}
            />

            <AddMemberDialog open={addMemberOpen} onOpenChange={setAddMemberOpen} roomId={activeRoomId} />
            <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} roomId={activeRoomId} />
          </>
        )}

        {dragging && (
          <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/85">
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <Upload className="h-4 w-4" />
              松手即可上传到共享文件区
            </div>
          </div>
        )}
      </main>

      <div className={cn('hidden md:block', !rightPanelOpen && 'md:hidden')}>
        <RightPanel onAddMember={() => setAddMemberOpen(true)} />
      </div>

      {/* 手机端抽屉：房间列表 */}
      {roomDrawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            onClick={() => setRoomDrawerOpen(false)}
            aria-label="关闭房间列表"
          />
          <div className="absolute inset-y-0 left-0 w-[82%] max-w-xs bg-background shadow-xl">
            <RoomList onNavigate={() => setRoomDrawerOpen(false)} />
          </div>
        </div>
      )}

      {/* 手机端抽屉：成员 / 文件 / AI 面板 */}
      {panelDrawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            onClick={() => setPanelDrawerOpen(false)}
            aria-label="关闭成员面板"
          />
          <div className="absolute inset-y-0 right-0 w-[90%] max-w-sm bg-background shadow-xl">
            <RightPanel
              onClose={() => setPanelDrawerOpen(false)}
              onAddMember={() => {
                setPanelDrawerOpen(false);
                setAddMemberOpen(true);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
