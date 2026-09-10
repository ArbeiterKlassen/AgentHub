import { create } from 'zustand';
import { apiClient, configureApi } from '@/lib/api';
import { log } from '@/lib/logger';
import type { ChatMessage, Member, RealtimeEvent, RoomSummary, SharedFile } from '@/lib/types';
import { useSessionStore } from './session';

interface TypingState {
  tag: string;
  nickname: string;
  runId: string;
}

interface ChatState {
  rooms: RoomSummary[];
  activeRoomId: string | null;
  messages: Record<string, ChatMessage[]>;
  members: Record<string, Member[]>;
  files: Record<string, SharedFile[]>;
  typing: Record<string, TypingState[]>;
  connected: boolean;
  loadingRooms: boolean;
  loadingRoom: boolean;
  error: string | null;

  loadRooms: () => Promise<RoomSummary[]>;
  openRoom: (roomId: string) => Promise<void>;
  createRoom: (input: { name: string; topic?: string; members?: string[] }) => Promise<RoomSummary>;
  refreshRoom: (roomId: string) => Promise<void>;
  send: (text: string, files?: string[], replyTo?: number | null) => Promise<void>;
  upload: (file: File) => Promise<void>;
  removeMessage: (id: number) => Promise<void>;
  removeFile: (id: string) => Promise<void>;
  removeMember: (tag: string) => Promise<void>;
  addMember: (tag: string) => Promise<void>;
  control: (action: 'pause' | 'resume' | 'stop') => Promise<void>;
  speak: (tag: string) => Promise<void>;
  discuss: (topic: string, tags: string[], rounds: number) => Promise<void>;
  setConnected: (connected: boolean) => void;
  handleEvent: (event: RealtimeEvent) => void;
  reset: () => void;
}

function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const map = new Map(existing.map((m) => [m.id, m]));
  for (const message of incoming) map.set(message.id, message);
  return [...map.values()].sort((a, b) => a.id - b.id);
}

export const useChatStore = create<ChatState>()((set, get) => ({
  rooms: [],
  activeRoomId: null,
  messages: {},
  members: {},
  files: {},
  typing: {},
  connected: false,
  loadingRooms: false,
  loadingRoom: false,
  error: null,

  loadRooms: async () => {
    set({ loadingRooms: true, error: null });
    try {
      const { rooms } = await apiClient.rooms();
      set({ rooms, loadingRooms: false });
      return rooms;
    } catch (err) {
      set({ loadingRooms: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  openRoom: async (roomId) => {
    set({ activeRoomId: roomId, loadingRoom: true });
    try {
      const [detail, history] = await Promise.all([
        apiClient.room(roomId),
        apiClient.messages(roomId, { limit: 100 }),
      ]);
      set((state) => ({
        members: { ...state.members, [roomId]: detail.members },
        files: { ...state.files, [roomId]: detail.files },
        messages: { ...state.messages, [roomId]: history.messages },
        rooms: state.rooms.some((r) => r.id === roomId)
          ? state.rooms.map((r) => (r.id === roomId ? detail.room : r))
          : [...state.rooms, detail.room],
        loadingRoom: false,
      }));
    } catch (err) {
      set({ loadingRoom: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  createRoom: async (input) => {
    const { room } = await apiClient.createRoom(input);
    set((state) => ({ rooms: [...state.rooms, room] }));
    await get().openRoom(room.id);
    return room;
  },

  refreshRoom: async (roomId) => {
    const detail = await apiClient.room(roomId);
    set((state) => ({
      members: { ...state.members, [roomId]: detail.members },
      files: { ...state.files, [roomId]: detail.files },
      rooms: state.rooms.map((r) => (r.id === roomId ? detail.room : r)),
    }));
  },

  send: async (text, files = [], replyTo = null) => {
    const roomId = get().activeRoomId;
    if (!roomId) return;
    const { message } = await apiClient.sendMessage(roomId, { text, files, replyTo });
    set((state) => ({
      messages: { ...state.messages, [roomId]: mergeMessages(state.messages[roomId] ?? [], [message]) },
    }));
  },

  upload: async (file) => {
    const roomId = get().activeRoomId;
    if (!roomId) return;
    const res = await apiClient.uploadFile(roomId, file);
    set((state) => ({
      files: { ...state.files, [roomId]: [res.file, ...(state.files[roomId] ?? [])] },
      messages: { ...state.messages, [roomId]: mergeMessages(state.messages[roomId] ?? [], [res.message]) },
    }));
  },

  removeMessage: async (id) => {
    const roomId = get().activeRoomId;
    if (!roomId) return;
    await apiClient.deleteMessage(roomId, id);
    set((state) => ({
      messages: { ...state.messages, [roomId]: (state.messages[roomId] ?? []).filter((m) => m.id !== id) },
    }));
  },

  removeFile: async (id) => {
    const roomId = get().activeRoomId;
    if (!roomId) return;
    await apiClient.deleteFile(id);
    set((state) => ({
      files: { ...state.files, [roomId]: (state.files[roomId] ?? []).filter((f) => f.id !== id) },
    }));
  },

  removeMember: async (tag) => {
    const roomId = get().activeRoomId;
    if (!roomId) return;
    await apiClient.removeMember(roomId, tag);
    await get().refreshRoom(roomId);
  },

  addMember: async (tag) => {
    const roomId = get().activeRoomId;
    if (!roomId) return;
    await apiClient.addMember(roomId, tag);
    await get().refreshRoom(roomId);
  },

  control: async (action) => {
    const roomId = get().activeRoomId;
    if (!roomId) return;
    await apiClient.control(roomId, action);
    await get().refreshRoom(roomId);
  },

  speak: async (tag) => {
    const roomId = get().activeRoomId;
    if (!roomId) return;
    await apiClient.speak(roomId, tag);
  },

  discuss: async (topic, tags, rounds) => {
    const roomId = get().activeRoomId;
    if (!roomId) return;
    await apiClient.discuss(roomId, { topic, tags, rounds });
  },

  setConnected: (connected) => set({ connected }),

  handleEvent: (event) => {
    const state = get();
    switch (event.type) {
      case 'hello': {
        set({ connected: true });
        break;
      }
      case 'message': {
        const message = event.data as ChatMessage;
        if (!message?.id) break;
        set((s) => ({
          messages: {
            ...s.messages,
            [message.roomId]: mergeMessages(s.messages[message.roomId] ?? [], [message]),
          },
          rooms: s.rooms.map((room) =>
            room.id === message.roomId
              ? {
                  ...room,
                  lastMessage: message,
                  messageCount: room.messageCount + 1,
                }
              : room,
          ),
        }));
        break;
      }
      case 'typing': {
        const data = event.data as { tag: string; nickname: string; runId: string; state: 'start' | 'stop' };
        const roomId = event.roomId ?? '';
        set((s) => {
          const current = s.typing[roomId] ?? [];
          const next =
            data.state === 'start'
              ? [...current.filter((t) => t.tag !== data.tag), { tag: data.tag, nickname: data.nickname, runId: data.runId }]
              : current.filter((t) => t.runId !== data.runId && t.tag !== data.tag);
          return { typing: { ...s.typing, [roomId]: next } };
        });
        break;
      }
      case 'agent.status': {
        const data = event.data as { tag: string; status: Member['status']; detail: string | null; queue: number };
        set((s) => {
          const updates: Record<string, Member[]> = {};
          for (const [roomId, list] of Object.entries(s.members)) {
            if (!list.some((m) => m.tag === data.tag)) continue;
            updates[roomId] = list.map((m) =>
              m.tag === data.tag ? { ...m, status: data.status, statusDetail: data.detail, queue: data.queue } : m,
            );
          }
          return { members: { ...s.members, ...updates } };
        });
        break;
      }
      case 'presence': {
        const data = event.data as { tag: string; online: boolean };
        set((s) => {
          const next: Record<string, Member[]> = {};
          for (const [roomId, list] of Object.entries(s.members)) {
            next[roomId] = list.map((m) => (m.tag === data.tag ? { ...m, online: data.online } : m));
          }
          return { members: { ...s.members, ...next } };
        });
        break;
      }
      case 'file.add': {
        const file = event.data as SharedFile;
        const roomId = file?.roomId ?? event.roomId ?? '';
        if (!roomId || !file?.id) break;
        set((s) => ({ files: { ...s.files, [roomId]: [file, ...(s.files[roomId] ?? [])] } }));
        break;
      }
      case 'file.remove': {
        const data = event.data as { id: string };
        const roomId = event.roomId ?? '';
        set((s) => ({
          files: { ...s.files, [roomId]: (s.files[roomId] ?? []).filter((f) => f.id !== data.id) },
        }));
        break;
      }
      default:
        log.debug('未处理的实时事件', event.type);
    }
  },

  reset: () =>
    set({
      rooms: [],
      activeRoomId: null,
      messages: {},
      members: {},
      files: {},
      typing: {},
      error: null,
    }),
}));

/** 页面加载时把持久化的 server/token 同步给 API 客户端 */
export function syncApiConfig(): void {
  const { server, token } = useSessionStore.getState();
  configureApi({ server, token });
}
