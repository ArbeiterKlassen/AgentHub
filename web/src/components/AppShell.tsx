import { useEffect } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Bot, LogOut, MessagesSquare, Moon, PanelRight, Settings, Sun, Wifi, WifiOff } from 'lucide-react';
import { useSessionStore } from '@/stores/session';
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/ui/button';
import { Toasts } from '@/components/Toasts';
import { cn } from '@/lib/utils';
import { applyThemeClass } from '@/lib/theme';
import { log } from '@/lib/logger';

const NAV = [
  { to: '/', label: '群聊', icon: MessagesSquare, end: true },
  { to: '/agents', label: 'AI 成员', icon: Bot, end: false },
  { to: '/settings', label: '设置', icon: Settings, end: false },
];

export function AppShell() {
  const member = useSessionStore((s) => s.member);
  const clear = useSessionStore((s) => s.clear);
  const connected = useChatStore((s) => s.connected);
  const resetChat = useChatStore((s) => s.reset);
  const { theme, toggleTheme, rightPanelOpen, toggleRightPanel } = useUiStore();
  const navigate = useNavigate();

  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  const logout = () => {
    log.action('退出登录');
    clear();
    resetChat();
    navigate('/login');
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <Link to="/" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <MessagesSquare className="h-4 w-4" />
          </span>
          <span className="text-base font-bold">
            Agent<span className="text-primary">Hub</span>
          </span>
        </Link>

        <nav className="ml-2 flex items-center gap-1">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors',
                  isActive
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <span
            className={cn(
              'mr-1 hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs sm:flex',
              connected ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
            )}
            title={connected ? '实时连接正常' : '实时连接断开，正在重连（仍可手动刷新）'}
          >
            {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            {connected ? '实时在线' : '重连中'}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleRightPanel}
            title={rightPanelOpen ? '收起侧栏' : '展开成员/文件侧栏'}
            className="hidden md:inline-flex"
          >
            <PanelRight className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={toggleTheme} title="切换主题">
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          {member && (
            <div className="ml-1 flex items-center gap-2 rounded-full border py-1 pl-1 pr-2">
              <Avatar member={member} size="sm" />
              <div className="hidden leading-tight sm:block">
                <div className="text-xs font-medium">{member.nickname}</div>
                <div className="text-[10px] text-muted-foreground">
                  @{member.tag}
                  {member.kind === 'agent' ? ' · AI' : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={logout}
                className="text-muted-foreground transition-colors hover:text-destructive"
                title="退出登录"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
      <Toasts />
    </div>
  );
}
