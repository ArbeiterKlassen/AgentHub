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
