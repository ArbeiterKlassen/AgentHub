import { useEffect, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { useSessionStore } from '@/stores/session';
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AvatarPicker } from '@/components/AvatarPicker';
import { cn, copyText } from '@/lib/utils';
import { log } from '@/lib/logger';
import type { AdapterInfo } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}

export function NewAgentDialog({ open, onOpenChange, onCreated }: Props) {
  const [tag, setTag] = useState('');
  const [nickname, setNickname] = useState('');
  const [adapterId, setAdapterId] = useState('mock');
  const [avatar, setAvatar] = useState('🤖');
  const [workdir, setWorkdir] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [triggerMode, setTriggerMode] = useState<'mentions' | 'all' | 'manual'>('mentions');
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ tag: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const server = useSessionStore((s) => s.server);
  const activeRoomId = useChatStore((s) => s.activeRoomId);
  const addMember = useChatStore((s) => s.addMember);
  const pushToast = useUiStore((s) => s.pushToast);

  useEffect(() => {
    if (!open) return;
    apiClient
      .adapters()
      .then((res) => setAdapters(res.adapters.filter((a) => !a.disabled)))
      .catch(() => setAdapters([]));
  }, [open]);

  const submit = async () => {
    if (!tag.trim()) return;
    setBusy(true);
    try {
      const res = await apiClient.register({
        tag: tag.trim().toLowerCase(),
        nickname: nickname.trim() || tag.trim(),
        kind: 'agent',
        adapterId,
        agentKind: adapterId,
        avatar,
        workdir: workdir.trim() || undefined,
        systemPrompt: systemPrompt.trim() || undefined,
        triggerMode,
      });
      log.action('创建 AI 成员', res.member.tag);
      setCreated({ tag: res.member.tag, token: res.token });
      if (activeRoomId) {
        await addMember(res.member.tag);
        pushToast(`@${res.member.tag} 已加入当前房间`, 'success');
      } else {
        pushToast(`AI 成员 @${res.member.tag} 已创建`, 'success');
      }
      onCreated?.();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const fullCommand = created
    ? [
        `node server/bin/ah.mjs login --tag ${created.tag} --token ${created.token}` +
          (server ? ` --server ${server}` : ''),
        `node server/bin/ah.mjs agent run --tag ${created.tag}${activeRoomId ? ` --room ${activeRoomId}` : ''}`,
      ].join('\n')
    : '';

  const selectedAdapter = adapters.find((a) => a.id === adapterId);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setCreated(null);
          setTag('');
          setNickname('');
          setSystemPrompt('');
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增 AI 成员</DialogTitle>
          <DialogDescription>
            每个 AI 成员都有自己的 tag 和登录 token，可被 @ 唤醒。创建后有两种运行方式：服务端直接跑，或在你本机用 CLI 边缘运行。
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3">
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="font-medium text-emerald-600 dark:text-emerald-400">✅ @{created.tag} 创建成功</p>
              <p className="mt-1 text-xs text-muted-foreground">
                把这个 token 记下来（也可以随时在设置页里查看/重置）。下面两行命令可以让你本机的 AI CLI 以这个身份进群：
              </p>
            </div>
            <pre className="thin-scrollbar overflow-x-auto rounded-lg border bg-muted/60 p-3 text-xs">{fullCommand}</pre>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await copyText(fullCommand);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              复制命令
            </Button>
            <p className="text-xs text-muted-foreground">
              提示：也可以直接在网页里点「让 TA 发言」，由服务端调用这台机器上的 CLI（适配器：{adapterId}）。
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="agent-tag">登录 tag</Label>
                <Input
                  id="agent-tag"
                  value={tag}
                  onChange={(e) => setTag(e.target.value.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase())}
                  placeholder="codex-1"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-nickname">昵称</Label>
                <Input
                  id="agent-nickname"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder="Codex 一号"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>适配器（这个 AI 由谁驱动）</Label>
              <Select value={adapterId} onValueChange={setAdapterId}>
                <SelectTrigger>
                  <SelectValue placeholder="选择适配器" />
                </SelectTrigger>
                <SelectContent>
                  {adapters.map((adapter) => (
                    <SelectItem key={adapter.id} value={adapter.id}>
                      {adapter.available ? '🟢' : '⚪️'} {adapter.label}（{adapter.id}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedAdapter && (
                <p className="text-xs text-muted-foreground">
                  {selectedAdapter.description}
                  {!selectedAdapter.available && (
                    <span className="text-amber-600 dark:text-amber-400"> · 当前不可用：{selectedAdapter.probeDetail}</span>
                  )}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>头像</Label>
              <AvatarPicker value={avatar} onChange={setAvatar} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="agent-cwd">工作目录（CLI 的 cwd）</Label>
                <Input
                  id="agent-cwd"
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
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="agent-prompt">专属设定（可选）</Label>
              <Textarea
                id="agent-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="例如：你是一位严格的代码评审者，只关注可维护性与边界条件。"
                rows={3}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {created ? (
            <Button onClick={() => onOpenChange(false)}>完成</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button onClick={() => void submit()} disabled={busy || !tag.trim()}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                创建
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
