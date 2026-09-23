import { useEffect } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Bot, Check, Languages, LogOut, MessagesSquare, Moon, PanelRight, Settings, Sun, Wifi, WifiOff } from 'lucide-react';
import { useSessionStore } from '@/stores/session';
import { useChatStore } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/ui/button';
import { Toasts } from '@/components/Toasts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { applyThemeClass } from '@/lib/theme';
import { LOCALES, LOCALE_LABELS, useI18n } from '@/lib/i18n';
import { log } from '@/lib/logger';

const NAV = [
  { to: '/', key: 'nav.chat', icon: MessagesSquare, end: true },
  { to: '/agents', key: 'nav.agents', icon: Bot, end: false },
  { to: '/settings', key: 'nav.settings', icon: Settings, end: false },
] as const;

export function AppShell() {
  const member = useSessionStore((s) => s.member);
  const clear = useSessionStore((s) => s.clear);
  const connected = useChatStore((s) => s.connected);
  const resetChat = useChatStore((s) => s.reset);
  const { theme, toggleTheme, rightPanelOpen, toggleRightPanel } = useUiStore();
  const { t, locale, setLocale } = useI18n();
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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-2 sm:gap-3 sm:px-4">
        <Link to="/" className="flex shrink-0 items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <MessagesSquare className="h-4 w-4" />
          </span>
          <span className="hidden text-base font-bold sm:inline">
            Agent<span className="text-primary">Hub</span>
          </span>
        </Link>

        <nav className="ml-1 flex min-w-0 items-center gap-0.5 sm:ml-2 sm:gap-1">
          {NAV.map(({ to, key, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm transition-colors sm:px-3',
                  isActive
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )
              }
            >
              <Icon className="h-4 w-4" />
              <span className="hidden md:inline">{t(key)}</span>
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
          <span
            className={cn(
              'mr-1 hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs sm:flex',
              connected ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
            )}
            title={connected ? t('app.connectedTitle') : t('app.disconnectedTitle')}
          >
            {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            {connected ? t('app.connected') : t('app.reconnecting')}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleRightPanel}
            title={rightPanelOpen ? t('app.collapsePanel') : t('app.expandPanel')}
            className="hidden md:inline-flex"
          >
            <PanelRight className="h-4 w-4" />
          </Button>
          {/* 语言切换：只改浏览器本地渲染，不参与任何请求（见 lib/i18n.ts） */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" title={t('app.language')}>
                <Languages className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {LOCALES.map((item) => (
                <DropdownMenuItem key={item} onClick={() => setLocale(item)}>
                  <Check className={cn('h-3 w-3', locale === item ? 'opacity-100' : 'opacity-0')} />
                  {LOCALE_LABELS[item]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" onClick={toggleTheme} title={t('app.toggleTheme')}>
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
                title={t('app.logout')}
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
