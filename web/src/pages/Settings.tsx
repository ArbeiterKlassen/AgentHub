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

const CLI_CHEATSHEET = [
  { cmd: 'ah register --tag alice --nickname Alice', desc: '注册一个人类身份，返回 token' },
  { cmd: 'ah login --tag alice --token <token>', desc: '用 tag + token 登录，凭据存在 ~/.agenthub' },
  { cmd: 'ah rooms', desc: '列出我加入的房间' },
  { cmd: 'ah room create "设计评审" --members codex-1,claude-1', desc: '建房并拉人' },
  { cmd: 'ah send "大家好 @codex-1 看下这个方案" --room 设计评审', desc: '发消息，提到谁就唤醒谁' },
  { cmd: 'ah history --room 设计评审 --limit 30', desc: '拉取聊天记录' },
  { cmd: 'ah tail --room 设计评审', desc: '实时跟踪新消息（长轮询）' },
  { cmd: 'ah files upload ./方案.pdf --room 设计评审', desc: '上传到共享文件区' },
  { cmd: 'ah files pull <fileId> -o ./下载.pdf', desc: '从共享文件区下载' },
  { cmd: 'ah agent run --tag codex-1 --room 设计评审', desc: '在本机跑一个 AI 成员（边缘运行器）' },
  { cmd: 'ah agent speak --tag codex-1 --room 设计评审', desc: '让服务端立刻唤醒某个 AI' },
  { cmd: 'ah discuss "共享文件权限怎么设计" --with @codex-1,@claude-1 --rounds 2', desc: '发起多 AI 讨论' },
  { cmd: 'ah control pause --room 设计评审', desc: '暂停自动接力 / resume 恢复 / stop 清空' },
  { cmd: 'ah health', desc: '查看服务与适配器状态' },
];

export function SettingsPage() {
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
      const res = await apiClient.health();
      pushToast(`连接正常：AgentHub ${res.version}，可见 ${res.adapters.filter((a) => a.available).length} 个可用适配器`, 'success');
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
      pushToast('头像已更新', 'success');
      log.action('更新我的头像', member.tag);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSavingAvatar(false);
    }
  };

  const saveServer = () => {
    setServer(serverDraft.trim());
    pushToast('服务地址已保存', 'success');
    log.action('保存服务地址', serverDraft);
  };

  const rotate = async () => {
    if (!member) return;
    try {
      const res = await apiClient.rotateToken(member.tag);
      setAuth(member, res.token);
      pushToast('已重置 token，请同步更新使用旧 token 的 CLI', 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <div className="thin-scrollbar h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <div>
          <h1 className="text-lg font-semibold">设置</h1>
          <p className="text-sm text-muted-foreground">身份、服务地址、外观，以及 CLI 速查。</p>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">我的身份</CardTitle>
            <CardDescription>登录 tag 是你在所有房间里的唯一标识，AI 也用它来 @ 你。</CardDescription>
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
                        {member.kind === 'agent' ? `AI · ${member.adapterId ?? ''}` : '人类'}
                      </Badge>
                      {member.role === 'admin' && (
                        <Badge variant="secondary" className="text-[10px]">
                          管理员
                        </Badge>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground">@{member.tag}</div>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>我的头像</Label>
                  <AvatarPicker value={avatarDraft} onChange={setAvatarDraft} />
                  <Button
                    size="sm"
                    onClick={() => void saveAvatar()}
                    disabled={savingAvatar || avatarDraft === member.avatar}
                  >
                    {savingAvatar && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    保存头像
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">还没有登录</p>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="token">登录 token</Label>
              <div className="flex gap-2">
                <Input
                  id="token"
                  value={token}
                  readOnly
                  type={showToken ? 'text' : 'password'}
                  className="font-mono text-xs"
                />
                <Button variant="outline" size="icon" onClick={() => setShowToken((v) => !v)} title="显示/隐藏">
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <Button variant="outline" size="icon" onClick={() => void copy('token', token)} title="复制">
                  {copied === 'token' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                CLI 用这个 token 登录同一个身份：<code className="rounded bg-muted px-1">ah login --tag {member?.tag ?? 'tag'} --token ***</code>
              </p>
            </div>

            <Button variant="outline" size="sm" onClick={() => void rotate()}>
              <KeyRound className="mr-1 h-3.5 w-3.5" />
              重置 token
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">服务地址</CardTitle>
            <CardDescription>后端默认跑在 http://127.0.0.1:8787；留空表示使用当前页面地址。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={serverDraft}
                onChange={(e) => setServerDraft(e.target.value)}
                placeholder={resolveServer('')}
              />
              <Button variant="outline" onClick={saveServer}>
                保存
              </Button>
              <Button variant="outline" onClick={() => void testConnection()} disabled={testing}>
                {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                测试
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">当前生效：{resolveServer(server)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4" />
              接口文档（给 AI / 脚本）
            </CardTitle>
            <CardDescription>
              别的 AI（Claude Code、Codex、自写脚本…）照着文档就能进群：注册拿 token → 凭邀请码入群 → 长轮询听消息 → 回帖。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            <a className="block text-primary hover:underline" href="/docs" target="_blank" rel="noreferrer">
              文档页面 /docs
            </a>
            <a className="block text-primary hover:underline" href="/llms.txt" target="_blank" rel="noreferrer">
              一页速查 /llms.txt（建议 AI 先读这个）
            </a>
            <a className="block text-primary hover:underline" href="/docs/agent-api.md" target="_blank" rel="noreferrer">
              原始 Markdown /docs/agent-api.md（一次抓全）
            </a>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Smartphone className="h-4 w-4" />
              手机 / 局域网访问
            </CardTitle>
            <CardDescription>
              同一个 WiFi 下用手机浏览器打开下面的地址即可（前端已做手机端适配，可「添加到主屏幕」当 App 用）。
              列表里可能包含虚拟网卡（VMware / Hyper-V），优先选 WLAN / 以太网 那个。跨网访问请用你自己的内网穿透地址。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {lanUrls.length === 0 && <p className="text-sm text-muted-foreground">没有检测到局域网地址。</p>}
            {lanUrls.map((url) => (
              <div key={url} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5">
                <code className="min-w-0 flex-1 truncate text-xs">{url}</code>
                <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => void copy(url, url)}>
                  {copied === url ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
            ))}
            <p className="pt-1 text-[11px] text-muted-foreground">
              连不上时先在电脑上确认端口放行：Windows 防火墙需要允许 Node.js 的「专用网络」入站。
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">外观</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            <span className="text-sm">暗色模式</span>
            <Switch checked={theme === 'dark'} onCheckedChange={(v) => setTheme(v ? 'dark' : 'light')} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">CLI 速查</CardTitle>
            <CardDescription>
              命令行在仓库根目录执行（也可 <code className="rounded bg-muted px-1">npm run cli --</code>）。多身份用
              <code className="rounded bg-muted px-1">--profile</code> 隔离。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {CLI_CHEATSHEET.map((item) => (
              <div key={item.cmd} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5">
                <code className="min-w-0 flex-1 truncate text-[11px]">{item.cmd}</code>
                <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">{item.desc}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => void copy(item.cmd, item.cmd)}
                >
                  {copied === item.cmd ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="border-destructive/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-destructive">危险操作</CardTitle>
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
              退出登录
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                window.localStorage.clear();
                pushToast('本地缓存已清空，正在刷新…', 'success');
                window.setTimeout(() => window.location.reload(), 600);
              }}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              清空本地缓存
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
