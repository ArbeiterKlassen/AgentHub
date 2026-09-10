import { useEffect } from 'react';
import { resolveServer } from '@/lib/api';
import { RealtimeClient } from '@/lib/ws';
import { useChatStore } from '@/stores/chat';
import { useSessionStore } from '@/stores/session';
import { log } from '@/lib/logger';

/** 建立到后端的实时连接（含自动重连），把事件泵进 chat store */
export function useRealtime(): void {
  const token = useSessionStore((s) => s.token);
  const server = useSessionStore((s) => s.server);
  const handleEvent = useChatStore((s) => s.handleEvent);
  const setConnected = useChatStore((s) => s.setConnected);

  useEffect(() => {
    if (!token) return;
    const client = new RealtimeClient(resolveServer(server), token, [], {
      onEvent: handleEvent,
      onStateChange: (state) => {
        setConnected(state === 'open');
        if (state === 'closed') log.ws('连接已断开，等待重连');
      },
    });
    client.connect();
    return () => {
      client.close();
      setConnected(false);
    };
    // handleEvent / setConnected 在 zustand 里是稳定引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, server]);
}
