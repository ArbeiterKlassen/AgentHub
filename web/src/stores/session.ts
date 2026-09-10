import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { configureApi, resolveServer } from '@/lib/api';
import type { Member } from '@/lib/types';

interface SessionState {
  server: string;
  token: string;
  member: Member | null;
  setServer: (server: string) => void;
  setAuth: (member: Member, token: string) => void;
  setMember: (member: Member) => void;
  clear: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      server: '',
      token: '',
      member: null,
      setServer: (server) => {
        configureApi({ server });
        set({ server });
      },
      setAuth: (member, token) => {
        configureApi({ token });
        set({ member, token });
      },
      setMember: (member) => set({ member }),
      clear: () => {
        configureApi({ token: '' });
        set({ token: '', member: null });
      },
    }),
    {
      name: 'agenthub-session',
      version: 1,
      onRehydrateStorage: () => (state) => {
        if (state) configureApi({ server: state.server, token: state.token });
      },
    },
  ),
);

export function currentServerOrigin(): string {
  return resolveServer(useSessionStore.getState().server);
}
