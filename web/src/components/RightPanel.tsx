import { useRef } from 'react';
import {
  Bot,
  Download,
  FileText,
  Loader2,
  MessageSquarePlus,
  Pause,
  Play,
  ScrollText,
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
import { downloadUrl } from '@/lib/api';
import { isImageFile } from '@/lib/fileKind';
import { formatDateTime, formatSize } from '@/lib/format';
import { cn } from '@/lib/utils';
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
  const activeRoomId = useChatStore((s) => s.activeRoomId);
  const room = useChatStore((s) => s.rooms.find((r) => r.id === s.activeRoomId));
  const { rightTab, setRightTab, pushToast, insertToComposer } = useUiStore();
  const me = useSessionStore((s) => s.member);
  const server = useSessionStore((s) => s.server);
  const token = useSessionStore((s) => s.token);
  const removeMember = useChatStore((s) => s.removeMember);
  const removeFile = useChatStore((s) => s.removeFile);
  const upload = useChatStore((s) => s.upload);
  const control = useChatStore((s) => s.control);
  const speak = useChatStore((s) => s.speak);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const list = activeRoomId ? (members[activeRoomId] ?? []) : [];
  const roomFiles = activeRoomId ? (files[activeRoomId] ?? []) : [];
  const typingTags = activeRoomId ? (typing[activeRoomId] ?? []).map((t) => t.tag) : [];
  const agents = list.filter((m) => m.kind === 'agent');

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
              {!roomFiles.length && (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  还没有共享文件。上传的文件会同时以消息形式出现在群里，AI 也能看到文件名。
                </p>
              )}
              {roomFiles.map((file) => (
                <div key={file.id} className="rounded-lg border bg-card p-2">
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
                    {isImageFile(file) ? (
                      <span className="h-4 w-4 shrink-0 text-center text-[11px] leading-4">🖼</span>
                    ) : (
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</span>
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
                            await removeFile(file.id);
                            pushToast('文件已删除', 'success');
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
  return (
    <div className="rounded-lg border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <Avatar member={agent} size="sm" showPresence online={agent.online} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{agent.nickname}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            @{agent.tag} · {agent.adapterId ?? 'AI'}
          </div>
        </div>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[10px]',
            status === 'thinking' && 'bg-primary/15 text-primary',
            status === 'idle' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
            status === 'error' && 'bg-destructive/15 text-destructive',
            status === 'offline' && 'bg-muted text-muted-foreground',
          )}
        >
          {STATUS_LABEL[status] ?? status}
          {agent.queue ? ` · 排队 ${agent.queue}` : ''}
        </span>
      </div>
      {agent.statusDetail && agent.status === 'error' && (
        <p className="mt-1.5 text-[11px] text-destructive">{agent.statusDetail}</p>
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
