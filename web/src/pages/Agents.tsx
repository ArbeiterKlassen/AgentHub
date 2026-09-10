import { useEffect, useState } from 'react';
import {
  Bot,
  Check,
  Copy,
  Loader2,
  Pencil,
  RefreshCw,
  ScrollText,
  Terminal,
  UserRound,
} from 'lucide-react';
import { apiClient } from '@/lib/api';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import { Avatar } from '@/components/Avatar';
import { AvatarPicker } from '@/components/AvatarPicker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { NewAgentDialog } from '@/components/dialogs/NewAgentDialog';
import { AgentLogsDialog } from '@/components/dialogs/AgentLogsDialog';
import { copyText } from '@/lib/utils';
import { log } from '@/lib/logger';
import type { AdapterInfo, Member } from '@/lib/types';

export function AgentsPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [copiedTag, setCopiedTag] = useState<string | null>(null);
  const [confirmDeleteTag, setConfirmDeleteTag] = useState<string | null>(null);
  const me = useSessionStore((s) => s.member);
  const server = useSessionStore((s) => s.server);
  const pushToast = useUiStore((s) => s.pushToast);

  const load = async () => {
    setLoading(true);
    try {
      const [memberRes, adapterRes] = await Promise.all([apiClient.members(), apiClient.adapters()]);
      setMembers(memberRes.members);
      setAdapters(adapterRes.adapters);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copyLogin = async (member: Member) => {
    try {
      const { token } = await apiClient.memberToken(member.tag);
      const lines = [
        `cd <AgentHub 仓库目录>`,
        `node server/bin/ah.mjs login --tag ${member.tag} --token ${token}${server ? ` --server ${server}` : ''}`,
        `node server/bin/ah.mjs agent run --tag ${member.tag} --adapter ${member.adapterId ?? 'mock'}`,
      ].join('\n');
      await copyText(lines);
      setCopiedTag(member.tag);
      window.setTimeout(() => setCopiedTag(null), 1500);
      pushToast('CLI 登录/启动命令已复制', 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const removeAgent = async (member: Member) => {
    try {
      await apiClient.deleteMember(member.tag, true);
      setConfirmDeleteTag(null);
      pushToast(`已删除成员 @${member.tag}（群里已有的发言记录会保留）`, 'success');
      log.action('删除 AI 成员', member.tag);
      await load();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const agents = members.filter((m) => m.kind === 'agent');
  const humans = members.filter((m) => m.kind !== 'agent');

  return (
    <div className="thin-scrollbar h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-lg font-semibold">AI 成员</h1>
            <p className="text-sm text-muted-foreground">
              每个 AI 成员 = 一个登录 tag + 一个适配器（本机的 Codex / Claude Code / DeepSeek Harness / ZCode / 本地模型…）。
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              刷新
            </Button>
            <Button size="sm" onClick={() => setNewAgentOpen(true)}>
              <Bot className="mr-1 h-3.5 w-3.5" />
              新增 AI 成员
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">适配器可用性</CardTitle>
            <CardDescription>
              适配器定义在仓库根目录的 <code className="rounded bg-muted px-1">adapters.json</code>，数据目录下的同名文件可覆盖它。
              加一种新 CLI 只需要在那里加一条。
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 md:grid-cols-2">
            {adapters.map((adapter) => (
              <div key={adapter.id} className="rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <span className={adapter.available ? 'text-emerald-500' : 'text-muted-foreground'}>
                    {adapter.available ? '●' : '○'}
                  </span>
                  <span className="text-sm font-medium">{adapter.label}</span>
                  <Badge variant="outline" className="ml-auto text-[10px]">
                    {adapter.id}
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">{adapter.description}</p>
                <p className="mt-1 truncate text-[11px] text-muted-foreground/80" title={adapter.probeDetail}>
                  {adapter.probeDetail || (adapter.disabled ? '模板未启用' : '')}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">AI 成员（{agents.length}）</h2>
          {!agents.length && (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              还没有 AI 成员。点右上角「新增 AI 成员」创建一个，再用「让 TA 发言」测试连通性。
            </p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            {agents.map((agent) => (
              <Card key={agent.tag}>
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center gap-2">
                    <Avatar member={agent} />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{agent.nickname}</div>
                      <div className="truncate text-xs text-muted-foreground">@{agent.tag}</div>
                    </div>
                    <Badge variant="secondary" className="ml-auto text-[10px]">
                      {agent.adapterId ?? 'AI'}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                    <Badge variant="outline" className="text-[10px]">
                      触发：{agent.triggerMode === 'all' ? '所有消息' : agent.triggerMode === 'manual' ? '手动' : '被 @'}
                    </Badge>
                    {agent.workdir && (
                      <span className="max-w-full truncate" title={agent.workdir}>
                        cwd: {agent.workdir}
                      </span>
                    )}
                    {agent.systemPrompt && <span className="truncate">设定：{agent.systemPrompt.slice(0, 40)}</span>}
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setEditing(agent)}>
                      <Pencil className="h-3 w-3" />
                      编辑
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setLogsFor(agent.tag)}>
                      <ScrollText className="h-3 w-3" />
                      运行记录
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void copyLogin(agent)}>
                      {copiedTag === agent.tag ? <Check className="h-3 w-3" /> : <Terminal className="h-3 w-3" />}
                      CLI 登录命令
                    </Button>
                    {me?.role === 'admin' &&
                      (confirmDeleteTag === agent.tag ? (
                        <>
                          <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={() => void removeAgent(agent)}>
                            确认删除
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setConfirmDeleteTag(null)}>
                            取消
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs text-destructive"
                          onClick={() => setConfirmDeleteTag(agent.tag)}
                          title="删除这个 AI 成员身份（消息记录保留）"
                        >
                          删除
                        </Button>
                      ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">人类成员（{humans.length}）</h2>
          <div className="grid gap-2 md:grid-cols-3">
            {humans.map((human) => (
              <div key={human.tag} className="flex items-center gap-2 rounded-lg border bg-card p-3">
                <Avatar member={human} size="sm" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{human.nickname}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    @{human.tag} {human.role === 'admin' ? '· 管理员' : ''} {human.tag === me?.tag ? '· 你' : ''}
                  </div>
                </div>
                <UserRound className="ml-auto h-4 w-4 text-muted-foreground" />
              </div>
            ))}
          </div>
        </section>
      </div>

      <NewAgentDialog open={newAgentOpen} onOpenChange={setNewAgentOpen} onCreated={() => void load()} />
      <EditAgentDialog
        agent={editing}
        adapters={adapters}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
      <AgentLogsDialog open={Boolean(logsFor)} onOpenChange={(open) => !open && setLogsFor(null)} agentTag={logsFor} />
    </div>
  );
}

function EditAgentDialog({
  agent,
  adapters,
  onClose,
  onSaved,
}: {
  agent: Member | null;
  adapters: AdapterInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState('🤖');
  const [adapterId, setAdapterId] = useState('mock');
  const [workdir, setWorkdir] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [triggerMode, setTriggerMode] = useState<'mentions' | 'all' | 'manual'>('mentions');
  const [busy, setBusy] = useState(false);
  const pushToast = useUiStore((s) => s.pushToast);

  useEffect(() => {
    if (!agent) return;
    setNickname(agent.nickname);
    setAvatar(agent.avatar || '🤖');
    setAdapterId(agent.adapterId ?? 'mock');
    setWorkdir(agent.workdir ?? '');
    setSystemPrompt(agent.systemPrompt ?? '');
    setTriggerMode(agent.triggerMode ?? 'mentions');
  }, [agent]);

  const save = async () => {
    if (!agent) return;
    setBusy(true);
    try {
      await apiClient.patchMember(agent.tag, {
        nickname,
        avatar,
        adapterId,
        agentKind: adapterId,
        workdir,
        systemPrompt,
        triggerMode,
      });
      log.action('更新 AI 成员', agent.tag);
      pushToast(`@${agent.tag} 已更新`, 'success');
      onSaved();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(agent)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑 @{agent?.tag}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="edit-nickname">昵称</Label>
            <Input id="edit-nickname" value={nickname} onChange={(e) => setNickname(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>头像</Label>
            <AvatarPicker value={avatar} onChange={setAvatar} />
          </div>
          <div className="space-y-1.5">
            <Label>适配器</Label>
            <Select value={adapterId} onValueChange={setAdapterId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {adapters
                  .filter((a) => !a.disabled)
                  .map((adapter) => (
                    <SelectItem key={adapter.id} value={adapter.id}>
                      {adapter.available ? '🟢' : '⚪️'} {adapter.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-workdir">工作目录</Label>
            <Input
              id="edit-workdir"
              value={workdir}
              onChange={(e) => setWorkdir(e.target.value)}
              placeholder="留空则用 data/workspaces/<tag>"
            />
          </div>
          <div className="space-y-1.5">
            <Label>触发方式</Label>
            <Select value={triggerMode} onValueChange={(v) => setTriggerMode(v as typeof triggerMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mentions">被 @ 时参与</SelectItem>
                <SelectItem value="all">所有人类消息都参与</SelectItem>
                <SelectItem value="manual">只在手动点名时发言</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-prompt">专属设定</Label>
            <Textarea id="edit-prompt" rows={3} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
