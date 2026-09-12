import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { ChatPage } from '@/pages/Chat';
import { AgentsPage } from '@/pages/Agents';
import { SettingsPage } from '@/pages/Settings';
import { LoginPage } from '@/pages/Login';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSessionStore } from '@/stores/session';
import { syncApiConfig } from '@/stores/chat';
import { useUiStore } from '@/stores/ui';
import { applyThemeClass } from '@/lib/theme';
import { log } from '@/lib/logger';
import { apiClient } from '@/lib/api';

function RequireAuth({ children }: { children: JSX.Element }) {
  const token = useSessionStore((s) => s.token);
  const location = useLocation();
  if (!token) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return children;
}

export default function App() {
  const theme = useUiStore((s) => s.theme);

  useEffect(() => {
    syncApiConfig();
    log.info('AgentHub 前端启动');
    /**
     * 启动时用 token 拉一次自己的资料：昵称、头像、尤其是**角色**可能在服务端被改过
     * （例如被提为管理员，见 scripts/set-role.mjs）。只依赖登录时的那份快照，
     * 界面会一直停在旧状态——管理员按钮不出现，用户只能靠重新登录才能看到。
     */
    const { token, setMember } = useSessionStore.getState();
    if (!token) return;
    void apiClient
      .me()
      .then((res) => setMember(res.member))
      .catch((err: unknown) => log.warn('刷新自己的资料失败（不影响使用）', err));
  }, []);

  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  return (
    <TooltipProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route path="/" element={<ChatPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </TooltipProvider>
  );
}
