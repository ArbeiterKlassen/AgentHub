import { useRef } from 'react';
import {
  Bot,
  Copy,
  Download,
  FileText,
  Loader2,
  MessageSquarePlus,
  Pause,
  Play,
  ScrollText,
  Settings,
  StopCircle,
  Trash2,
  Upload,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react';
import { useChatStore } from '@/stores/chat';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import { Avatar } from '@/components/Avatar';
import { ImageAttachment } from '@/components/ImageAttachment';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AgentLogsDialog } from '@/components/dialogs/AgentLogsDialog';
import { RoomSettingsDialog } from '@/components/dialogs/RoomSettingsDialog';
import { apiClient, downloadRoomExport, downloadUrl } from '@/lib/api';
import { isImageFile } from '@/lib/fileKind';
import { formatDateTime, formatRelative, formatSize } from '@/lib/format';
import { cn, copyText } from '@/lib/utils';
import { log } from '@/lib/logger';
import { useI18n } from '@/lib/i18n';
import { useState } from 'react';
import type { Member } from '@/lib/types';

const STATUS_KEY: Record<string, string> = {
  idle: 'panel.status.idle',
  thinking: 'panel.status.thinking',
  error: 'panel.status.error',
  offline: 'panel.status.offline',
};

export function RightPanel({ onClose, onAddMember }: { onClose?: () => void; onAddMember?: () => void } = {}) {
  const { t } = useI18n();
const { members, files, loadingRoom, typing } = useChatStore();
  const refreshRoom = useChatStore((s) => s.refreshRoom);
  const activeRoomId = useChatStore((s) => s.activeRoomId);
  const room = useChatStore((s) => s.rooms.find((r) => r.id === s.activeRoomId));
  const { rightTab, setRightTab, pushToast, insertToComposer } = useUiStore();
  const me = useSessionStore((s) => s.member);
  const server = useSessionStore((s) => s.server);
  const token = useSessionStore((s) => s.token);
  const removeMember = useChatStore((s) => s.removeMember);
  const removeFile = useChatStore((s) => s.removeFile);
  const removeFiles = useChatStore((s) => s.removeFiles);
  const upload = useChatStore((s) => s.upload);
  const control = useChatStore((s) => s.control);
  const speak = useChatStore((s) => s.speak);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  /** 共享文件区：管理模式下可多选删除 */
  const [manageFiles, setManageFiles] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const list = activeRoomId ? (members[activeRoomId] ?? []) : [];
  const roomFiles = activeRoomId ? (files[activeRoomId] ?? []) : [];
  const typingTags = activeRoomId ? (typing[activeRoomId] ?? []).map((t) => t.tag) : [];
  const agents = list.filter((m) => m.kind === 'agent');
  const deletableFiles = roomFiles.filter((f) => me && (f.uploaderTag === me.tag || me.role === 'admin'));
  const filesTotalBytes = roomFiles.reduce((sum, f) => sum + (f.size ?? 0), 0);

  const toggleFileSelected = (id: string) => {
    setSelectedFiles((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const deleteSelectedFiles = async () => {
    if (!selectedFiles.length) return;
    const ok = window.confirm(t('panel.files.confirmDelete', { n: selectedFiles.length }));
    if (!ok) return;
    try {
      const res = await removeFiles(selectedFiles);
      const failed = res.failed?.length ?? 0;
      pushToast(
        failed
          ? t('panel.files.deletedWithFailures', { ok: res.deleted.length, failed })
          : t('panel.files.deleted', { n: res.deleted.length }),
        failed ? 'error' : 'success',
      );
      setSelectedFiles([]);
      setManageFiles(false);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const onFiles = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    for (const file of Array.from(fileList)) {
      try {
        await upload(file);
        pushToast(t('chat.uploaded', { name: file.name }), 'success');
      } catch (err) {
        pushToast(err instanceof Error ? err.message : String(err), 'error');
      }
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-l bg-muted/20 md:w-80">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {onClose && (
          <Button variant="ghost" size="icon" className="h-8 w-8 md:hidden" onClick={onClose} title={t('common.close')}>
            <X className="h-4 w-4" />
          </Button>
        )}
        <Tabs value={rightTab} onValueChange={(v) => setRightTab(v as typeof rightTab)} className="flex-1">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="members" className="text-xs">
              {t('panel.tab.members', { n: list.length })}
            </TabsTrigger>
            <TabsTrigger value="files" className="text-xs">
              {t('panel.tab.files', { n: roomFiles.length })}
            </TabsTrigger>
            <TabsTrigger value="agents" className="text-xs">
              AI {agents.length}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {!activeRoomId ? (
          <p className="p-4 text-sm text-muted-foreground">{t('panel.pickRoom')}</p>
      ) : loadingRoom ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
          <Tabs value={rightTab} onValueChange={(v) => setRightTab(v as typeof rightTab)}>
            <TabsContent value="members" className="mt-0 space-y-1.5">
              {room?.code && (
                <div className="rounded-lg border bg-card p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground">{t('panel.invite.title')}</span>
                    {(me?.role === 'admin' || room.createdBy === me?.tag) && (
                      <button
                        type="button"
                        className="text-[11px] text-muted-foreground hover:text-destructive"
                        title={t('panel.invite.rotateTitle')}
                        onClick={async () => {
                          try {
                            await apiClient.rotateRoomCode(room.id);
                            await refreshRoom(room.id);
                            pushToast(t('panel.invite.rotated'), 'success');
                          } catch (err) {
                            pushToast(err instanceof Error ? err.message : String(err), 'error');
                          }
                        }}
                      >
                        {t('panel.invite.rotate')}
                      </button>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="flex-1 font-mono text-lg font-semibold tracking-[0.25em]">{room.code}</code>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      title={t('panel.invite.copyTitle')}
                      onClick={async () => {
                        await copyText(room.code);
                        pushToast(t('panel.invite.copied'), 'success');
                      }}
                    >
                      <Copy className="h-3 w-3" />
                      {t('common.copy')}
                    </Button>
                  </div>
                  <button
                    type="button"
                    className="mt-1.5 w-full rounded border border-dashed px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent"
                    onClick={async () => {
                      const text = t('panel.invite.shareBody', {
                        room: room.name,
                        code: room.code,
                        url: window.location.origin,
                      });
                      await copyText(text);
                      pushToast(t('panel.invite.shareCopied'), 'success');
                    }}
                  >
                    {t('panel.invite.copyShare')}
                  </button>
                </div>
              )}

              {room && (
                <div className="rounded-lg border bg-card p-2.5">
                  <div className="text-[11px] text-muted-foreground">{t('panel.export.title')}</div>
                  <div className="mt-1 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 flex-1 px-2 text-xs"
                      title={t('panel.export.mdTitle')}
                      onClick={() => {
                        downloadRoomExport(server, room.id, room.name, 'md', { limit: 5000 });
                        pushToast(t('panel.export.mdStarted'), 'success');
                      }}
                    >
                      <Download className="mr-1 h-3 w-3" />
                      Markdown
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 flex-1 px-2 text-xs"
                      title={t('panel.export.jsonTitle')}
                      onClick={() => {
                        downloadRoomExport(server, room.id, room.name, 'json', { limit: 5000 });
                        pushToast(t('panel.export.jsonStarted'), 'success');
                      }}
                    >
                      <Download className="mr-1 h-3 w-3" />
                      JSON
                    </Button>
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground">{t('panel.export.hint')}</p>
                </div>
              )}

              {room && (
                <Button variant="outline" size="sm" className="w-full" onClick={() => setSettingsOpen(true)}>
                  <Settings className="h-3.5 w-3.5" />
                  {t('panel.roomSettings')}
                </Button>
              )}

              {onAddMember && (
                <Button variant="outline" size="sm" className="w-full" onClick={onAddMember}>
                  <UserPlus className="h-3.5 w-3.5" />
                  {t('panel.addMember')}
                </Button>
              )}
              {list.map((member) => (
                <div key={member.tag} className="flex items-center gap-2 rounded-lg border bg-card p-2">
                  <Avatar member={member} size="sm" showPresence online={member.online} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{member.nickname}</span>
                      {member.role === 'admin' && (
                        <Badge variant="outline" className="h-4 px-1 text-[10px]">
                          {t('panel.admin')}
                        </Badge>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">@{member.tag}</div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title={t('panel.mention')}
                    onClick={() => insertToComposer(`@${member.tag} `)}
                  >
                    <MessageSquarePlus className="h-3.5 w-3.5" />
                  </Button>
                  {me && (member.tag === me.tag || me.role === 'admin') && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      title={t('panel.removeFromRoom')}
                      onClick={async () => {
                        try {
                          await removeMember(member.tag);
                          pushToast(t('panel.removedFromRoom', { tag: member.tag }), 'success');
                        } catch (err) {
                          pushToast(err instanceof Error ? err.message : String(err), 'error');
                        }
                      }}
                    >
                      <UserMinus className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </TabsContent>

            <TabsContent value="files" className="mt-0 space-y-2">
              <input ref={fileInput} type="file" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
              <Button variant="outline" size="sm" className="w-full" onClick={() => fileInput.current?.click()}>
                <Upload className="h-3.5 w-3.5" />
                {t('panel.files.upload')}
              </Button>

              {/* 文件区概览 + 批量管理入口 */}
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>
                  {t('panel.files.summary', { n: roomFiles.length, size: formatSize(filesTotalBytes) })}
                </span>
                {deletableFiles.length > 0 && (
                  <button
                    type="button"
                    className="ml-auto rounded border border-dashed px-1.5 py-0.5 transition-colors hover:bg-accent"
                    onClick={() => {
                      setManageFiles((v) => !v);
                      setSelectedFiles([]);
                    }}
                  >
                    {manageFiles ? t('panel.files.manageOff') : t('panel.files.manage')}
                  </button>
                )}
              </div>

              {manageFiles && (
                <div className="rounded-lg border border-dashed bg-muted/30 p-2">
                  <div className="flex items-center gap-2 text-[11px]">
                    <button
                      type="button"
                      className="text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() =>
                        setSelectedFiles(
                          selectedFiles.length === deletableFiles.length ? [] : deletableFiles.map((f) => f.id),
                        )
                      }
                    >
                      {selectedFiles.length === deletableFiles.length ? t('panel.files.deselectAll') : t('panel.files.selectAll')}
                    </button>
                    <span className="text-muted-foreground">
                      {t('panel.files.selected', { selected: selectedFiles.length, deletable: deletableFiles.length })}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto h-6 px-2 text-[11px] text-destructive"
                      disabled={!selectedFiles.length}
                      onClick={() => void deleteSelectedFiles()}
                    >
                      <Trash2 className="mr-1 h-3 w-3" />
                      {t('panel.files.deleteSelected')}
                    </Button>
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {t('panel.files.manageHint')}
                  </p>
                </div>
              )}

              {!roomFiles.length && (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  {t('panel.files.empty')}
                </p>
              )}
              {roomFiles.map((file) => (
                <div
                  key={file.id}
                  className={cn(
                    'rounded-lg border bg-card p-2',
                    manageFiles && selectedFiles.includes(file.id) && 'ring-1 ring-primary/50',
                  )}
                >
                  {isImageFile(file) && (
                    <ImageAttachment
                      file={file}
                      server={server}
                      token={token}
                      showLabel={false}
                      thumbClassName="mb-2 max-h-40 w-full object-cover"
                      className="mb-1"
                    />
                  )}
                  <div className="flex items-center gap-2">
                    {manageFiles &&
                      (deletableFiles.some((f) => f.id === file.id) ? (
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 shrink-0 accent-primary"
                          checked={selectedFiles.includes(file.id)}
                          onChange={() => toggleFileSelected(file.id)}
                          title={t('panel.files.selectHint')}
                        />
                      ) : (
                        <span className="h-3.5 w-3.5 shrink-0" title={t('panel.files.notYours')} />
                      ))}
                    {isImageFile(file) ? (
                      <span className="h-4 w-4 shrink-0 text-center text-[11px] leading-4">🖼</span>
                    ) : (
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</span>
                    {(file.version ?? 1) > 1 && (
                      <span
                        className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground"
                        title={file.previousId ? t('panel.files.previousVersion', { id: file.previousId }) : undefined}
                      >
                        v{file.version}
                      </span>
                    )}
                    <a
                      href={downloadUrl(server, file.id, token)}
                      className="text-muted-foreground transition-colors hover:text-foreground"
                      download={file.name}
                      title={t('common.download')}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                    {me && (file.uploaderTag === me.tag || me.role === 'admin') && (
                      <button
                        type="button"
                        className="text-muted-foreground transition-colors hover:text-destructive"
                        title={t('common.delete')}
                        onClick={async () => {
                          try {
                            const res = await removeFile(file.id);
                            pushToast(
                              res?.hint ? t('panel.files.deletedWithHint', { hint: res.hint }) : t('panel.files.deleted'),
                              'success',
                            );
                          } catch (err) {
                            pushToast(err instanceof Error ? err.message : String(err), 'error');
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="mt-1 pl-6 text-[11px] text-muted-foreground">
                    {formatSize(file.size)} · @{file.uploaderTag} · {formatDateTime(file.createdAt)}
                  </div>
                </div>
              ))}
            </TabsContent>

            <TabsContent value="agents" className="mt-0 space-y-2">
              {room?.paused && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
                  {t('panel.agents.paused')}
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => void control(room?.paused ? 'resume' : 'pause')}
                >
                  {room?.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                  {room?.paused ? t('panel.agents.resume') : t('panel.agents.pause')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 text-destructive"
                  onClick={async () => {
                    const res = await control('stop').then(() => true).catch(() => false);
                    if (res) pushToast(t('panel.agents.stopped'), 'success');
                  }}
                >
                  <StopCircle className="h-3.5 w-3.5" />
                  {t('panel.agents.stopAll')}
                </Button>
              </div>

              {!agents.length && (
                <p className="py-4 text-center text-xs text-muted-foreground">{t('panel.agents.empty')}</p>
              )}
              {agents.map((agent) => (
                <AgentCard
                  key={agent.tag}
                  agent={agent}
                  thinking={typingTags.includes(agent.tag)}
                  onMention={() => insertToComposer(`@${agent.tag} `)}
                  onSpeak={async () => {
                    try {
                      await speak(agent.tag);
                      pushToast(t('panel.agents.spoken', { tag: agent.tag }), 'success');
                      log.action('手动唤醒 AI', agent.tag);
                    } catch (err) {
                      pushToast(err instanceof Error ? err.message : String(err), 'error');
                    }
                  }}
                  onLogs={() => setLogsFor(agent.tag)}
                />
              ))}
            </TabsContent>
          </Tabs>
        </div>
      )}

      <AgentLogsDialog open={Boolean(logsFor)} onOpenChange={(open) => !open && setLogsFor(null)} agentTag={logsFor} />
      <RoomSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} room={room ?? null} />
    </aside>
  );
}

function AgentCard({
  agent,
  thinking,
  onMention,
  onSpeak,
  onLogs,
}: {
  agent: Member;
  thinking: boolean;
  onMention: () => void;
  onSpeak: () => void;
  onLogs: () => void;
}) {
  const { t } = useI18n();
  const status = thinking ? 'thinking' : (agent.status ?? 'offline');
  /**
   * 外部客户端（adapter=external）由它自己轮询取消息，服务端不代跑，所以既没有
   * WebSocket 连接也不会有运行记录——旧版这里永远显示「离线」。现在按最近活跃时间显示。
   */
  const externalLabel = !agent.external
    ? null
    : agent.online
      ? t('panel.external.online')
      : agent.lastSeenAt
        ? t('panel.external.lastSeen', { time: formatRelative(agent.lastSeenAt) })
        : t('panel.external.offline');
  const showExternal = Boolean(agent.external);
  return (
    <div className="rounded-lg border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <Avatar member={agent} size="sm" showPresence online={agent.online} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{agent.nickname}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            @{agent.tag} · {showExternal ? t('panel.external.label') : (agent.adapterId ?? 'AI')}
          </div>
        </div>
        {showExternal ? (
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-[10px]',
              agent.online ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-muted-foreground',
            )}
            title={
              agent.lastSeenAt
                ? t('panel.external.lastSeenTitle', { time: formatDateTime(agent.lastSeenAt) })
                : t('panel.external.neverSeen')
            }
          >
            {externalLabel}
          </span>
        ) : (
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-[10px]',
              status === 'thinking' && 'bg-primary/15 text-primary',
              status === 'idle' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
              status === 'error' && 'bg-destructive/15 text-destructive',
              status === 'offline' && 'bg-muted text-muted-foreground',
            )}
          >
            {STATUS_KEY[status] ? t(STATUS_KEY[status]) : status}
            {agent.queue ? t('panel.queue', { n: agent.queue }) : ''}
          </span>
        )}
      </div>
      {agent.statusDetail && agent.status === 'error' && (
        <p className="mt-1.5 text-[11px] text-destructive">{agent.statusDetail}</p>
      )}
      {agent.presenceNote && (
        <p className="mt-1.5 truncate text-[11px] text-muted-foreground" title={agent.presenceNote}>
          💬 {agent.presenceNote}
        </p>
      )}
      <div className="mt-2 flex items-center gap-1">
        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
          {t('panel.trigger')}
          {agent.triggerMode === 'all'
            ? t('panel.trigger.all')
            : agent.triggerMode === 'manual'
              ? t('panel.trigger.manual')
              : t('panel.trigger.mentions')}
        </Badge>
        <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5 text-[11px]" onClick={onMention}>
          @TA
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={onSpeak} title={t('panel.agents.speakTitle')}>
          {t('panel.agents.speak')}
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={onLogs} title={t('panel.agents.logs')}>
          <ScrollText className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
