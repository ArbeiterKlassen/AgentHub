import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { applyThemeClass, startThemeTransition } from '@/lib/theme';

export type RightTab = 'members' | 'files' | 'agents';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

interface UiState {
  theme: 'light' | 'dark';
  rightPanelOpen: boolean;
  rightTab: RightTab;
  toasts: Toast[];
  /** 供消息里的 @提及 / 快捷按钮往输入框插入文本 */
  draftInsert: { text: string; nonce: number } | null;
  /** 侧栏里被折叠的分组（个人偏好，只存本地） */
  collapsedGroups: string[];
  toggleTheme: () => void;
  setTheme: (theme: 'light' | 'dark') => void;
  toggleRightPanel: () => void;
  setRightTab: (tab: RightTab) => void;
  pushToast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  insertToComposer: (text: string) => void;
  toggleGroupCollapsed: (groupId: string) => void;
}

let toastSeq = 0;

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      theme: 'light',
      rightPanelOpen: true,
      rightTab: 'members',
      toasts: [],
      draftInsert: null,
      collapsedGroups: [],
      toggleTheme: () => {
        const next = get().theme === 'dark' ? 'light' : 'dark';
        startThemeTransition();
        applyThemeClass(next);
        set({ theme: next });
      },
      setTheme: (theme) => {
        if (get().theme !== theme) {
          startThemeTransition();
          applyThemeClass(theme);
        }
        set({ theme });
      },
      toggleRightPanel: () => set({ rightPanelOpen: !get().rightPanelOpen }),
      setRightTab: (rightTab) => set({ rightTab, rightPanelOpen: true }),
      pushToast: (text, kind = 'info') => {
        const id = ++toastSeq;
        set({ toasts: [...get().toasts.slice(-4), { id, kind, text }] });
        window.setTimeout(() => {
          set({ toasts: get().toasts.filter((t) => t.id !== id) });
        }, kind === 'error' ? 8000 : 4000);
      },
      dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
      insertToComposer: (text) => set({ draftInsert: { text, nonce: Date.now() } }),
      toggleGroupCollapsed: (groupId) =>
        set((state) => ({
          collapsedGroups: state.collapsedGroups.includes(groupId)
            ? state.collapsedGroups.filter((id) => id !== groupId)
            : [...state.collapsedGroups, groupId],
        })),
    }),
    {
      name: 'agenthub-ui',
      version: 1,
      partialize: (state) => ({
        theme: state.theme,
        rightPanelOpen: state.rightPanelOpen,
        collapsedGroups: state.collapsedGroups,
      }),
    },
  ),
);
