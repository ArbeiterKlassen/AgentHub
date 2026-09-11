import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Loader2, LogIn, MessagesSquare, RefreshCw, UserPlus } from 'lucide-react';
import { apiClient, resolveServer } from '@/lib/api';
import { useSessionStore } from '@/stores/session';
import { useChatStore } from '@/stores/chat';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AvatarPicker } from '@/components/AvatarPicker';
import { cn } from '@/lib/utils';
import { log } from '@/lib/logger';
import type { AdapterInfo } from '@/lib/types';

export function LoginPage() {
  const navigate = useNavigate();
  const { server, setServer, setAuth } = useSessionStore();
  const loadRooms = useChatStore((s) => s.loadRooms);
  const [tab, setTab] = useState<'register' | 'login'>('register');
  const [tag, setTag] = useState('');
  const [nickname, setNickname] = useState('');
  const [token, setToken] = useState('');
  const [kind, setKind] = useState<'human' | 'agent'>('human');
  const [avatar, setAvatar] = useState('🙂');
  // 默认 external：服务端不代跑，AI 自己接入（mock 只是演示用，放最后）
  const [adapterId, setAdapterId] = useState('external');
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<{ ok: boolean; detail: string } | null>(null);
  // external 排最前、mock（演示用）排最后
  const orderedAdapters = [...adapters].sort((a, b) => {
    const rank = (x: AdapterInfo) => (x.id === 'external' ? 0 : x.id === 'mock' ? 2 : 1);
    return rank(a) - rank(b);
  });

  const probe = async (target?: string) => {
    const previous = useSessionStore.getState().server;
    if (target !== undefined) setServer(target);
    try {
      const res = await apiClient.health();
      setHealth({ ok: res.ok, detail: `AgentHub ${res.version} · Node ${res.node}` });
      setAdapters(res.adapters.filter((a) => !a.disabled));
      log.info('后端连通', res.version);
    } catch (err) {
      setHealth({ ok: false, detail: err instanceof Error ? err.message : String(err) });
      setAdapters([]);
      if (target !== undefined) setServer(previous);
    }
  };

  useEffect(() => {
    void probe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (tab === 'register') {
        const res = await apiClient.register({
          tag: tag.trim().toLowerCase(),
          nickname: nickname.trim() || tag.trim(),
          kind,
          avatar,
          adapterId: kind === 'agent' ? adapterId : undefined,
          agentKind: kind === 'agent' ? adapterId : undefined,
        });
        setAuth(res.member, res.token);
        log.action('注册成功', res.member.tag);
      } else {
        const res = await apiClient.login(tag.trim().toLowerCase(), token.trim());
        setAuth(res.member, res.token);
        log.action('登录成功', res.member.tag);
      }
      await loadRooms().catch(() => undefined);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-xl space-y-4">
        <div className="flex items-center justify-center gap-2">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <MessagesSquare className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-bold">
              Agent<span className="text-primary">Hub</span>
            </h1>
            <p className="text-xs text-muted-foreground">人和 Codex / Claude Code / DeepSeek Harness / ZCode 等任意 AI CLI 在同一个群里协作</p>
          </div>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">进入群聊</CardTitle>
            <CardDescription>
              每个人、每个 AI 都有自己的登录 tag 与昵称。注册后会拿到一个 token，CLI 用它登录同一个身份。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-xs', health?.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>
              <span className={cn('h-2 w-2 rounded-full', health?.ok ? 'bg-emerald-500' : 'bg-destructive')} />
              <span className="flex-1 truncate">{health ? health.detail : '正在连接后端…'}</span>
              <button type="button" className="flex items-center gap-1 hover:underline" onClick={() => void probe()}>
                <RefreshCw className="h-3 w-3" />
                重试
              </button>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="server">服务地址</Label>
              <div className="flex gap-2">
                <Input
                  id="server"
                  value={server}
                  placeholder={resolveServer('')}
                  onChange={(e) => setServer(e.target.value)}
                  className="flex-1"
                />
                <Button variant="outline" onClick={() => void probe(server)}>
                  测试连接
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">留空表示使用当前页面所在地址（前后端同端口部署时）。</p>
            </div>

            <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="register">
                  <UserPlus className="mr-1 h-3.5 w-3.5" />
                  注册新身份
                </TabsTrigger>
                <TabsTrigger value="login">
                  <LogIn className="mr-1 h-3.5 w-3.5" />
                  用 token 登录
                </TabsTrigger>
              </TabsList>

              <TabsContent value="register" className="space-y-3 pt-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="login-tag">登录 tag</Label>
                    <Input
                      id="login-tag"
                      value={tag}
                      onChange={(e) => setTag(e.target.value.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase())}
                      placeholder="alice"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="login-nickname">昵称</Label>
                    <Input
                      id="login-nickname"
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      placeholder="阿丽"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>身份类型</Label>
                  <div className="flex gap-2">
                    {[
                      { value: 'human', label: '人类用户', icon: '🙂' },
                      { value: 'agent', label: 'AI 成员', icon: '🤖' },
                    ].map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => setKind(item.value as 'human' | 'agent')}
                        className={cn(
                          'flex flex-1 items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
                          kind === item.value ? 'border-primary bg-accent' : 'hover:bg-accent/60',
                        )}
                      >
                        <span>{item.icon}</span>
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>

                {kind === 'agent' && (
                  <div className="space-y-1.5">
                    <Label>由哪个适配器驱动</Label>
                    <div className="grid gap-1.5">
                      {orderedAdapters.map((adapter) => (
                        <button
                          key={adapter.id}
                          type="button"
                          onClick={() => setAdapterId(adapter.id)}
                          className={cn(
                            'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                            adapterId === adapter.id ? 'border-primary bg-accent' : 'hover:bg-accent/60',
                          )}
                        >
                          <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="font-medium">{adapter.label}</span>
                          <span className="ml-auto text-[11px] text-muted-foreground">
                            {adapter.available ? '可用' : adapter.probeDetail}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label>头像</Label>
                  <AvatarPicker value={avatar} onChange={setAvatar} />
                </div>
              </TabsContent>

              <TabsContent value="login" className="space-y-3 pt-2">
                <div className="space-y-1.5">
                  <Label htmlFor="login-tag-2">登录 tag</Label>
                  <Input id="login-tag-2" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="alice" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="login-token">登录 token</Label>
                  <Input
                    id="login-token"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="注册时拿到的 token"
                    type="password"
                  />
                </div>
              </TabsContent>
            </Tabs>

            {error && <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}

            <Button className="w-full" onClick={() => void submit()} disabled={busy || !tag.trim() || (tab === 'login' && !token.trim())}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {tab === 'register' ? '注册并进入' : '登录'}
            </Button>
          </CardContent>
        </Card>

        <p className="text-center text-[11px] text-muted-foreground">
          首次注册的账号会成为管理员。AI 成员也可以用命令行注册：
          <code className="ml-1 rounded bg-muted px-1">ah register --tag codex-1 --kind agent --adapter codex</code>
        </p>
      </div>
    </div>
  );
}
