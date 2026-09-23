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
import { useI18n } from '@/lib/i18n';
import type { AdapterInfo, Member } from '@/lib/types';

export function AgentsPage() {
  const { t } = useI18n();
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
      t('agents.loginHint.cd'),
        `node server/bin/ah.mjs login --tag ${member.tag} --token ${token}${server ? ` --server ${server}` : ''}`,
        `node server/bin/ah.mjs agent run --tag ${member.tag} --adapter ${member.adapterId ?? 'mock'}`,
      ].join('\n');
      await copyText(lines);
      setCopiedTag(member.tag);
      window.setTimeout(() => setCopiedTag(null), 1500);
      pushToast(t('agents.cliCopied'), 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const removeAgent = async (member: Member) => {
    try {
      await apiClient.deleteMember(member.tag, true);
      setConfirmDeleteTag(null);
      pushToast(t('agents.deleted', { tag: member.tag }), 'success');
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
          <h1 className="text-lg font-semibold">{t('agents.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('agents.subtitle')}
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {t('common.refresh')}
            </Button>
            <Button size="sm" onClick={() => setNewAgentOpen(true)}>
              <Bot className="mr-1 h-3.5 w-3.5" />
              {t('agents.add')}
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('agents.adapters')}</CardTitle>
            <CardDescription>{t('agents.adaptersDesc')}</CardDescription>
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
                    {adapter.probeDetail || (adapter.disabled ? t('agents.templateDisabled') : '')}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{t('agents.listTitle', { n: agents.length })}</h2>
          {!agents.length && (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              {t('agents.empty')}
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
                      {t('panel.trigger')}
                      {agent.triggerMode === 'all'
                        ? t('panel.trigger.all')
                        : agent.triggerMode === 'manual'
                          ? t('panel.trigger.manual')
                          : t('panel.trigger.mentions')}
                    </Badge>
                    {agent.workdir && (
                      <span className="max-w-full truncate" title={agent.workdir}>
                        cwd: {agent.workdir}
                      </span>
                    )}
              {agent.systemPrompt && (
                <span className="truncate">{t('agents.promptPreview', { text: agent.systemPrompt.slice(0, 40) })}</span>
              )}
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setEditing(agent)}>
                      <Pencil className="h-3 w-3" />
                  {t('agents.edit')}
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setLogsFor(agent.tag)}>
                      <ScrollText className="h-3 w-3" />
                  {t('panel.agents.logs')}
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void copyLogin(agent)}>
                      {copiedTag === agent.tag ? <Check className="h-3 w-3" /> : <Terminal className="h-3 w-3" />}
                  {t('agents.cliLogin')}
                    </Button>
                    {me?.role === 'admin' &&
                      (confirmDeleteTag === agent.tag ? (
                        <>
                          <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={() => void removeAgent(agent)}>
                      {t('agents.confirmDelete')}
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setConfirmDeleteTag(null)}>
                      {t('common.cancel')}
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs text-destructive"
                          onClick={() => setConfirmDeleteTag(agent.tag)}
                    title={t('agents.deleteTitle')}
                        >
                    {t('common.delete')}
                        </Button>
                      ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{t('agents.humansTitle', { n: humans.length })}</h2>
          <div className="grid gap-2 md:grid-cols-3">
            {humans.map((human) => (
              <div key={human.tag} className="flex items-center gap-2 rounded-lg border bg-card p-3">
                <Avatar member={human} size="sm" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{human.nickname}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                @{human.tag} {human.role === 'admin' ? `· ${t('panel.admin')}` : ''}{' '}
                {human.tag === me?.tag ? `· ${t('agents.you')}` : ''}
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
  const { t } = useI18n();
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
      pushToast(t('agents.updated', { tag: agent.tag }), 'success');
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
          <DialogTitle>{t('agents.editTitle', { tag: agent?.tag ?? '' })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
              <Label htmlFor="edit-nickname">{t('login.nicknameLabel')}</Label>
            <Input id="edit-nickname" value={nickname} onChange={(e) => setNickname(e.target.value)} />
          </div>
          <div className="space-y-1.5">
              <Label>{t('settings.avatar')}</Label>
            <AvatarPicker value={avatar} onChange={setAvatar} />
          </div>
          <div className="space-y-1.5">
              <Label>{t('agents.edit.adapter')}</Label>
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
              <Label htmlFor="edit-workdir">{t('agents.edit.workdir')}</Label>
            <Input
              id="edit-workdir"
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
          <div className="space-y-1.5">
              <Label htmlFor="edit-prompt">{t('agents.edit.prompt')}</Label>
            <Textarea id="edit-prompt" rows={3} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
