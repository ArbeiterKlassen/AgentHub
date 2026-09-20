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
import { useState } from 'react';
import type { Member } from '@/lib/types';

const STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  thinking: '思考中',
  error: '出错',
  offline: '离线',
};

export function RightPanel({ onClose, onAddMember }: { onClose?: () => void; onAddMember?: () => void } = {}) {
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
    const ok = window.confirm(
      `确定删除选中的 ${selectedFiles.length} 个文件？\n文件会从磁盘上删掉，聊天里对应的附件会标记为「已被删除」。`,
    );
    if (!ok) return;
    try {
      const res = await removeFiles(selectedFiles);
      const failed = res.failed?.length ?? 0;
      pushToast(
        `已删除 ${res.deleted.length} 个文件${failed ? `，${failed} 个没删掉（没权限或已不存在）` : ''}`,
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
        pushToast(`已上传 ${file.name}`, 'success');
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
          <Button variant="ghost" size="icon" className="h-8 w-8 md:hidden" onClick={onClose} title="关闭">
            <X className="h-4 w-4" />
          </Button>
        )}
        <Tabs value={rightTab} onValueChange={(v) => setRightTab(v as typeof rightTab)} className="flex-1">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="members" className="text-xs">
              成员 {list.length}
            </TabsTrigger>
            <TabsTrigger value="files" className="text-xs">
              文件 {roomFiles.length}
            </TabsTrigger>
            <TabsTrigger value="agents" className="text-xs">
              AI {agents.length}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {!activeRoomId ? (
        <p className="p-4 text-sm text-muted-foreground">先选择一个房间</p>
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
                    <span className="text-[11px] text-muted-foreground">群聊识别码（邀请码）</span>
                    {(me?.role === 'admin' || room.createdBy === me?.tag) && (
                      <button
                        type="button"
                        className="text-[11px] text-muted-foreground hover:text-destructive"
                        title="重置邀请码（旧码立即失效）"
                        onClick={async () => {
                          try {
                            await apiClient.rotateRoomCode(room.id);
                            await refreshRoom(room.id);
                            pushToast('邀请码已重置，旧码失效', 'success');
                          } catch (err) {
                            pushToast(err instanceof Error ? err.message : String(err), 'error');
                          }
                        }}
                      >
                        重置
                      </button>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="flex-1 font-mono text-lg font-semibold tracking-[0.25em]">{room.code}</code>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      title="复制邀请码"
                      onClick={async () => {
                        await copyText(room.code);
                        pushToast('邀请码已复制', 'success');
                      }}
                    >
                      <Copy className="h-3 w-3" />
                      复制
                    </Button>
                  </div>
                  <button
                    type="button"
                    className="mt-1.5 w-full rounded border border-dashed px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent"
                    onClick={async () => {
                      const text = [
                        `【AgentHub 群聊邀请】${room.name}`,
                        `邀请码：${room.code}`,
                        `地址：${window.location.origin}`,
                        '加入方式：打开地址 → 登录/注册 → 房间列表点钥匙图标 → 填邀请码',
                      ].join('\n');
                      await copyText(text);
                      pushToast('邀请信息已复制，直接发给对方即可', 'success');
                    }}
                  >
                    复制邀请信息（含码 + 地址 + 步骤）
                  </button>
                </div>
              )}

              {room && (
                <div className="rounded-lg border bg-card p-2.5">
                  <div className="text-[11px] text-muted-foreground">导出聊天记录</div>
                  <div className="mt-1 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 flex-1 px-2 text-xs"
                      title="导出为 Markdown（最多 5000 条）"
                      onClick={() => {
                        downloadRoomExport(server, room.id, room.name, 'md', { limit: 5000 });
                        pushToast('已开始导出 Markdown', 'success');
                      }}
                    >
                      <Download className="mr-1 h-3 w-3" />
                      Markdown
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 flex-1 px-2 text-xs"
                      title="导出为 JSON（含 meta，便于脚本处理）"
                      onClick={() => {
                        downloadRoomExport(server, room.id, room.name, 'json', { limit: 5000 });
                        pushToast('已开始导出 JSON', 'success');
                      }}
                    >
                      <Download className="mr-1 h-3 w-3" />
                      JSON
                    </Button>
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground">想按关键词搜/只导出一部分，用标题栏的搜索</p>
                </div>
              )}

              {room && (
                <Button variant="outline" size="sm" className="w-full" onClick={() => setSettingsOpen(true)}>
                  <Settings className="h-3.5 w-3.5" />
                  房间设置（上下文预算 / 接力上限 / 心跳）
                </Button>
              )}

              {onAddMember && (
                <Button variant="outline" size="sm" className="w-full" onClick={onAddMember}>
                  <UserPlus className="h-3.5 w-3.5" />
                  拉人 / 拉 AI 进房间
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
                          管理员
                        </Badge>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">@{member.tag}</div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title="在输入框里 @TA"
                    onClick={() => insertToComposer(`@${member.tag} `)}
                  >
                    <MessageSquarePlus className="h-3.5 w-3.5" />
                  </Button>
                  {me && (member.tag === me.tag || me.role === 'admin') && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      title="移出房间"
                      onClick={async () => {
                        try {
                          await removeMember(member.tag);
                          pushToast(`@${member.tag} 已移出房间`, 'success');
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
                上传文件到共享文件区
              </Button>

              {/* 文件区概览 + 批量管理入口 */}
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>
                  {roomFiles.length} 个文件 · 共 {formatSize(filesTotalBytes)}
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
                    {manageFiles ? '取消管理' : '管理／批量删除'}
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
                      {selectedFiles.length === deletableFiles.length ? '全不选' : '全选可删的'}
                    </button>
                    <span className="text-muted-foreground">
                      已选 {selectedFiles.length}／可删 {deletableFiles.length}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto h-6 px-2 text-[11px] text-destructive"
                      disabled={!selectedFiles.length}
                      onClick={() => void deleteSelectedFiles()}
                    >
                      <Trash2 className="mr-1 h-3 w-3" />
                      删除选中
                    </Button>
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    能删的是你自己上传的（管理员可以删全部）。删除后聊天里的附件会显示「已被删除」，记录本身保留。
                  </p>
                </div>
              )}

              {!roomFiles.length && (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  还没有共享文件。上传的文件会同时以消息形式出现在群里，AI 也能看到文件名。
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
                          title="选中后可批量删除"
                        />
                      ) : (
                        <span className="h-3.5 w-3.5 shrink-0" title="这个文件不是你上传的，删不了" />
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
                        title={file.previousId ? `上一版：${file.previousId}` : undefined}
                      >
                        v{file.version}
                      </span>
                    )}
                    <a
                      href={downloadUrl(server, file.id, token)}
                      className="text-muted-foreground transition-colors hover:text-foreground"
                      download={file.name}
                      title="下载"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                    {me && (file.uploaderTag === me.tag || me.role === 'admin') && (
                      <button
                        type="button"
                        className="text-muted-foreground transition-colors hover:text-destructive"
                        title="删除"
                        onClick={async () => {
                          try {
                            const res = await removeFile(file.id);
                            pushToast(res?.hint ? `文件已删除；${res.hint}` : '文件已删除', 'success');
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
                  本房间的 AI 自动接力已暂停
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
                  {room?.paused ? '恢复接力' : '暂停接力'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 text-destructive"
                  onClick={async () => {
                    const res = await control('stop').then(() => true).catch(() => false);
                    if (res) pushToast('已清空排队任务并暂停', 'success');
                  }}
                >
                  <StopCircle className="h-3.5 w-3.5" />
                  全部停止
                </Button>
              </div>

              {!agents.length && <p className="py-4 text-center text-xs text-muted-foreground">房间里还没有 AI 成员</p>}
              {agents.map((agent) => (
                <AgentCard
                  key={agent.tag}
                  agent={agent}
                  thinking={typingTags.includes(agent.tag)}
                  onMention={() => insertToComposer(`@${agent.tag} `)}
                  onSpeak={async () => {
                    try {
                      await speak(agent.tag);
                      pushToast(`已让 @${agent.tag} 发言`, 'success');
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
  const status = thinking ? 'thinking' : (agent.status ?? 'offline');
  /**
   * 外部客户端（adapter=external）由它自己轮询取消息，服务端不代跑，所以既没有
   * WebSocket 连接也不会有运行记录——旧版这里永远显示「离线」。现在按最近活跃时间显示。
   */
  const externalLabel = !agent.external
    ? null
    : agent.online
      ? '在线（外部）'
      : agent.lastSeenAt
        ? `${formatRelative(agent.lastSeenAt)}活跃`
        : '未连接';
  const showExternal = Boolean(agent.external);
  return (
    <div className="rounded-lg border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <Avatar member={agent} size="sm" showPresence online={agent.online} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{agent.nickname}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            @{agent.tag} · {showExternal ? '外部客户端' : (agent.adapterId ?? 'AI')}
          </div>
        </div>
        {showExternal ? (
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-[10px]',
              agent.online ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-muted-foreground',
            )}
            title={agent.lastSeenAt ? `最后活跃：${formatDateTime(agent.lastSeenAt)}` : '这个 AI 客户端还没用它的 token 连过服务端'}
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
            {STATUS_LABEL[status] ?? status}
            {agent.queue ? ` · 排队 ${agent.queue}` : ''}
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
          触发：{agent.triggerMode === 'all' ? '所有消息' : agent.triggerMode === 'manual' ? '手动' : '被 @'}
        </Badge>
        <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5 text-[11px]" onClick={onMention}>
          @TA
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={onSpeak} title="让 TA 主动说一句">
          发言
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={onLogs} title="运行记录">
          <ScrollText className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
