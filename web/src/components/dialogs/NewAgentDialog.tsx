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
import { useI18n } from '@/lib/i18n';
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
  const { t } = useI18n();
  const [tag, setTag] = useState('');
  const [nickname, setNickname] = useState('');
  // 默认 external（服务端不代跑）；要服务端执行就选具体 CLI
  const [adapterId, setAdapterId] = useState('external');
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
      pushToast(t('dialog.newAgent.joined', { tag: res.member.tag }), 'success');
      } else {
      pushToast(t('dialog.newAgent.created', { tag: res.member.tag }), 'success');
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
  // external 排最前、mock（演示用）排最后，其余按服务端返回顺序
  const orderedAdapters = [...adapters].sort((a, b) => {
    const rank = (x: AdapterInfo) => (x.id === 'external' ? 0 : x.id === 'mock' ? 2 : 1);
    return rank(a) - rank(b);
  });

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
          <DialogTitle>{t('dialog.newAgent.title')}</DialogTitle>
          <DialogDescription>
            {t('dialog.newAgent.subtitle')}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3">
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <p className="font-medium text-emerald-600 dark:text-emerald-400">
              {t('dialog.newAgent.success', { tag: created.tag })}
            </p>
              <p className="mt-1 text-xs text-muted-foreground">
              {t('dialog.newAgent.tokenHint')}
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
              {t('dialog.newAgent.copyCommands')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t('dialog.newAgent.runHint', { adapter: adapterId })}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
              <Label htmlFor="agent-tag">{t('login.tagLabel')}</Label>
                <Input
                  id="agent-tag"
                  value={tag}
                  onChange={(e) => setTag(e.target.value.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase())}
                  placeholder="codex-1"
                />
              </div>
              <div className="space-y-1.5">
              <Label htmlFor="agent-nickname">{t('login.nicknameLabel')}</Label>
                <Input
                  id="agent-nickname"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                placeholder={t('dialog.newAgent.nicknamePlaceholder')}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>{t('agents.edit.adapter')}</Label>
              <Select value={adapterId} onValueChange={setAdapterId}>
                <SelectTrigger>
                  <SelectValue placeholder={t('dialog.newAgent.adapterPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {orderedAdapters.map((adapter) => (
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
                    <span className="text-amber-600 dark:text-amber-400">
                      {t('dialog.newAgent.adapterUnavailable', { detail: selectedAdapter.probeDetail })}
                    </span>
                  )}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>{t('settings.avatar')}</Label>
              <AvatarPicker value={avatar} onChange={setAvatar} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
              <Label htmlFor="agent-cwd">{t('dialog.newAgent.workdir')}</Label>
                <Input
                  id="agent-cwd"
                  value={workdir}
                  onChange={(e) => setWorkdir(e.target.value)}
                placeholder={t('agents.edit.workdirPlaceholder')}
                />
              </div>
              <div className="space-y-1.5">
              <Label>{t('agents.edit.trigger')}</Label>
                <Select value={triggerMode} onValueChange={(v) => setTriggerMode(v as typeof triggerMode)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                  <SelectItem value="mentions">{t('agents.edit.triggerMentions')}</SelectItem>
                  <SelectItem value="all">{t('agents.edit.triggerAll')}</SelectItem>
                  <SelectItem value="manual">{t('agents.edit.triggerManual')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="agent-prompt">{t('dialog.newAgent.prompt')}</Label>
              <Textarea
                id="agent-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={t('dialog.newAgent.promptPlaceholder')}
                rows={3}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {created ? (
              <Button onClick={() => onOpenChange(false)}>{t('dialog.newAgent.done')}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
              </Button>
              <Button onClick={() => void submit()} disabled={busy || !tag.trim()}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('common.create')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
