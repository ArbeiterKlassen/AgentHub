import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  FileText,
  KeyRound,
  Loader2,
  Moon,
  RefreshCw,
  Smartphone,
  Sun,
  Trash2,
} from 'lucide-react';
import { apiClient, resolveServer } from '@/lib/api';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import { useChatStore } from '@/stores/chat';
import { Avatar } from '@/components/Avatar';
import { AvatarPicker } from '@/components/AvatarPicker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { copyText } from '@/lib/utils';
import { log } from '@/lib/logger';
import { useI18n } from '@/lib/i18n';

const CLI_CHEATSHEET = [
  { cmdKey: 'settings.cli.cmd.register', descKey: 'settings.cli.register' },
  { cmdKey: 'settings.cli.cmd.login', descKey: 'settings.cli.login' },
  { cmdKey: 'settings.cli.cmd.rooms', descKey: 'settings.cli.rooms' },
  { cmdKey: 'settings.cli.cmd.roomCreate', descKey: 'settings.cli.roomCreate' },
  { cmdKey: 'settings.cli.cmd.send', descKey: 'settings.cli.send' },
  { cmdKey: 'settings.cli.cmd.history', descKey: 'settings.cli.history' },
  { cmdKey: 'settings.cli.cmd.tail', descKey: 'settings.cli.tail' },
  { cmdKey: 'settings.cli.cmd.filesUpload', descKey: 'settings.cli.filesUpload' },
  { cmdKey: 'settings.cli.cmd.filesPull', descKey: 'settings.cli.filesPull' },
  { cmdKey: 'settings.cli.cmd.agentRun', descKey: 'settings.cli.agentRun' },
  { cmdKey: 'settings.cli.cmd.agentSpeak', descKey: 'settings.cli.agentSpeak' },
  { cmdKey: 'settings.cli.cmd.discuss', descKey: 'settings.cli.discuss' },
  { cmdKey: 'settings.cli.cmd.control', descKey: 'settings.cli.control' },
  { cmdKey: 'settings.cli.cmd.health', descKey: 'settings.cli.health' },
];

export function SettingsPage() {
  const { t } = useI18n();
  const { server, token, member, setServer, setAuth, setMember, clear } = useSessionStore();
  const { theme, setTheme, pushToast } = useUiStore();
  const resetChat = useChatStore((s) => s.reset);
  const [serverDraft, setServerDraft] = useState(server);
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [lanUrls, setLanUrls] = useState<string[]>([]);

  useEffect(() => {
    apiClient
      .health()
      .then((res) => setLanUrls(res.lanUrls ?? []))
      .catch(() => setLanUrls([]));
  }, []);
  const [avatarDraft, setAvatarDraft] = useState(member?.avatar ?? '🙂');
  const [savingAvatar, setSavingAvatar] = useState(false);

  useEffect(() => {
    if (member) setAvatarDraft(member.avatar);
  }, [member?.avatar, member?.tag]);

  const copy = async (key: string, text: string) => {
    await copyText(text);
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1500);
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      const res = await apiClient.health(true);
      pushToast(
        t('settings.toast.connected', { version: res.version, n: res.adapters.filter((a) => a.available).length }),
        'success',
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setTesting(false);
    }
  };

  const saveAvatar = async () => {
    if (!member) return;
    setSavingAvatar(true);
    try {
      const res = await apiClient.patchMember(member.tag, { avatar: avatarDraft });
      setMember(res.member);
      pushToast(t('settings.toast.avatarSaved'), 'success');
      log.action('更新我的头像', member.tag);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSavingAvatar(false);
    }
  };

  const saveServer = () => {
    setServer(serverDraft.trim());
      pushToast(t('settings.toast.serverSaved'), 'success');
    log.action('保存服务地址', serverDraft);
  };

  const rotate = async () => {
    if (!member) return;
    try {
      const res = await apiClient.rotateToken(member.tag);
      setAuth(member, res.token);
      pushToast(t('settings.toast.tokenReset'), 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <div className="thin-scrollbar h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <div>
          <h1 className="text-lg font-semibold">{t('settings.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('settings.subtitle')}</p>
        </div>

        <Card>
          <CardHeader className="pb-3">
              <CardTitle className="text-base">{t('settings.identity')}</CardTitle>
              <CardDescription>{t('settings.identityDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {member ? (
              <>
                <div className="flex items-center gap-3">
                  <Avatar member={member} size="lg" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{member.nickname}</span>
                      <Badge variant="outline" className="text-[10px]">
                  {member.kind === 'agent' ? `AI · ${member.adapterId ?? ''}` : t('composer.human')}
                      </Badge>
                      {member.role === 'admin' && (
                        <Badge variant="secondary" className="text-[10px]">
                      {t('panel.admin')}
                        </Badge>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground">@{member.tag}</div>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>{t('settings.avatar')}</Label>
                  <AvatarPicker value={avatarDraft} onChange={setAvatarDraft} />
                  <Button
                    size="sm"
                    onClick={() => void saveAvatar()}
                    disabled={savingAvatar || avatarDraft === member.avatar}
                  >
                    {savingAvatar && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    {t('settings.saveAvatar')}
                  </Button>
                </div>
              </>
            ) : (
                <p className="text-sm text-muted-foreground">{t('settings.notLoggedIn')}</p>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="token">{t('settings.tokenLabel')}</Label>
              <div className="flex gap-2">
                <Input
                  id="token"
                  value={token}
                  readOnly
                  type={showToken ? 'text' : 'password'}
                  className="font-mono text-xs"
                />
                <Button variant="outline" size="icon" onClick={() => setShowToken((v) => !v)} title={t('settings.showHide')}>
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <Button variant="outline" size="icon" onClick={() => void copy('token', token)} title={t('common.copy')}>
                  {copied === 'token' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t('settings.cliLoginHint')}
                <code className="rounded bg-muted px-1">ah login --tag {member?.tag ?? 'tag'} --token ***</code>
              </p>
            </div>

            <Button variant="outline" size="sm" onClick={() => void rotate()}>
              <KeyRound className="mr-1 h-3.5 w-3.5" />
              {t('settings.resetToken')}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
              <CardTitle className="text-base">{t('settings.serverTitle')}</CardTitle>
              <CardDescription>{t('settings.serverDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={serverDraft}
                onChange={(e) => setServerDraft(e.target.value)}
                placeholder={resolveServer('')}
              />
              <Button variant="outline" onClick={saveServer}>
                  {t('common.save')}
              </Button>
              <Button variant="outline" onClick={() => void testConnection()} disabled={testing}>
                {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {t('settings.test')}
              </Button>
            </div>
              <p className="text-[11px] text-muted-foreground">{t('settings.currentServer', { server: resolveServer(server) })}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4" />
            {t('settings.docsTitle')}
            </CardTitle>
            <CardDescription>
            {t('settings.docsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            <a className="block text-primary hover:underline" href="/docs" target="_blank" rel="noreferrer">
            {t('settings.docPage')}
            </a>
            <a className="block text-primary hover:underline" href="/llms.txt" target="_blank" rel="noreferrer">
            {t('settings.llms')}
            </a>
            <a className="block text-primary hover:underline" href="/docs/agent-api.md" target="_blank" rel="noreferrer">
            {t('settings.apiMd')}
            </a>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Smartphone className="h-4 w-4" />
            {t('settings.lanTitle')}
            </CardTitle>
            <CardDescription>
            {t('settings.lanDesc')}
            {t('settings.lanHint')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {lanUrls.length === 0 && <p className="text-sm text-muted-foreground">{t('settings.noLan')}</p>}
            {lanUrls.map((url) => (
              <div key={url} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5">
                <code className="min-w-0 flex-1 truncate text-xs">{url}</code>
                <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => void copy(url, url)}>
                  {copied === url ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
            ))}
            <p className="pt-1 text-[11px] text-muted-foreground">
            {t('settings.firewallHint')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
              <CardTitle className="text-base">{t('settings.appearance')}</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                  <span className="text-sm">{t('settings.darkMode')}</span>
            <Switch checked={theme === 'dark'} onCheckedChange={(v) => setTheme(v ? 'dark' : 'light')} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
              <CardTitle className="text-base">{t('settings.cliTitle')}</CardTitle>
            <CardDescription>
              {t('settings.cliDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {CLI_CHEATSHEET.map((item) => {
              const cmd = t(item.cmdKey);
              return (
                <div key={item.cmdKey} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5">
                  <code className="min-w-0 flex-1 truncate text-[11px]">{cmd}</code>
                  <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">{t(item.descKey)}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={() => void copy(cmd, cmd)}
                  >
                    {copied === cmd ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card className="border-destructive/40">
          <CardHeader className="pb-3">
              <CardTitle className="text-base text-destructive">{t('settings.danger')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                clear();
                resetChat();
                window.location.href = '/login';
              }}
            >
              {t('app.logout')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                window.localStorage.clear();
      pushToast(t('settings.cacheCleared'), 'success');
                window.setTimeout(() => window.location.reload(), 600);
              }}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />
            {t('settings.clearCache')}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
