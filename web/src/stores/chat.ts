import { create } from 'zustand';
import { apiClient, configureApi } from '@/lib/api';
import { log } from '@/lib/logger';
import type { ChatMessage, Member, RealtimeEvent, RoomGroup, RoomSummary, SharedFile } from '@/lib/types';
import { useSessionStore } from './session';

interface TypingState {
  tag: string;
  nickname: string;
  runId: string;
}

interface ChatState {
  rooms: RoomSummary[];
  /** 群聊分组（房间级属性，所有人共享） */
  groups: RoomGroup[];
  activeRoomId: string | null;
  messages: Record<string, ChatMessage[]>;
  members: Record<string, Member[]>;
  files: Record<string, SharedFile[]>;
  typing: Record<string, TypingState[]>;
  connected: boolean;
  loadingRooms: boolean;
  loadingRoom: boolean;
  error: string | null;
  /** 搜索里点「定位」后要高亮的那条消息 */
  focusMessageId: number | null;

  loadRooms: () => Promise<RoomSummary[]>;
  loadGroups: () => Promise<RoomGroup[]>;
  createGroup: (name: string) => Promise<RoomGroup>;
  renameGroup: (id: string, name: string) => Promise<void>;
  deleteGroup: (id: string) => Promise<{ movedRooms: number }>;
  moveGroup: (id: string, sort: number) => Promise<void>;
  reorderGroups: (ids: string[]) => Promise<void>;
  moveRoomToGroup: (roomId: string, groupId: string | null) => Promise<void>;
  openRoom: (roomId: string) => Promise<void>;
  createRoom: (input: { name: string; topic?: string; members?: string[] }) => Promise<RoomSummary>;
  joinRoomByCode: (code: string) => Promise<{ room: RoomSummary; alreadyMember: boolean }>;
  dissolveRoom: (
    roomId: string,
    opts?: { keepFiles?: boolean },
  ) => Promise<{ name: string; hint: string; filesKept: boolean; deleted: Record<string, number> }>;
  refreshRoom: (roomId: string) => Promise<void>;
  send: (text: string, files?: string[], replyTo?: number | null) => Promise<void>;
  searchMessages: (roomId: string, query: string, limit?: number) => Promise<ChatMessage[]>;
  jumpToMessage: (roomId: string, messageId: number) => Promise<void>;
  clearFocus: () => void;
  upload: (file: File) => Promise<void>;
  removeMessage: (id: number) => Promise<void>;
  removeFile: (id: string) => Promise<{ detachedMessages?: number; hint?: string }>;
  removeFiles: (ids: string[]) => Promise<{ deleted: string[]; failed: Array<{ id: string; error: string }> }>;
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
  groups: [],
  activeRoomId: null,
  messages: {},
  members: {},
  files: {},
  typing: {},
  connected: false,
  loadingRooms: false,
  loadingRoom: false,
  error: null,
  focusMessageId: null,

  loadRooms: async () => {
    set({ loadingRooms: true, error: null });
    try {
      const { rooms } = await apiClient.rooms();
      set({ rooms, loadingRooms: false });
      // 分组跟房间一起刷新：侧栏分堆要用它
      void get()
        .loadGroups()
        .catch((err) => log.warn('加载分组失败', err));
      return rooms;
    } catch (err) {
      set({ loadingRooms: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  loadGroups: async () => {
    const { groups } = await apiClient.groups();
    set({ groups });
    return groups;
  },

  createGroup: async (name) => {
    const { group } = await apiClient.createGroup(name);
    // 服务端会把房间挂到分组上，这里把房间摘要里的 groupId 也一起对齐
    set((state) => ({ groups: [...state.groups, group].sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt) }));
    await get().loadGroups();
    log.action('新建分组', name);
    return group;
  },

  renameGroup: async (id, name) => {
    await apiClient.patchGroup(id, { name });
    await get().loadGroups();
  },

  deleteGroup: async (id) => {
    const res = await apiClient.deleteGroup(id);
    await Promise.all([get().loadGroups(), get().loadRooms()]);
    log.action('删除分组', `${id}（${res.movedRooms} 个房间回到未分组）`);
    return { movedRooms: res.movedRooms };
  },

  moveGroup: async (id, sort) => {
    await apiClient.patchGroup(id, { sort });
    await get().loadGroups();
  },

  /** 拖拽排序：先本地重排（界面跟手），再提交给服务端 */
  reorderGroups: async (ids) => {
    const current = get().groups;
    const byId = new Map(current.map((g) => [g.id, g]));
    const next = ids.map((id, index) => ({ ...(byId.get(id) as RoomGroup), sort: index + 1 })).filter((g) => g.id);
    if (next.length === current.length) set({ groups: next });
    await apiClient.reorderGroups(ids);
    await get().loadGroups();
  },

  /** 把房间移到某个分组（groupId=null 表示移出分组） */
  moveRoomToGroup: async (roomId, groupId) => {
    await apiClient.patchRoom(roomId, { groupId });
    set((state) => ({
      rooms: state.rooms.map((r) => (r.id === roomId ? { ...r, groupId } : r)),
    }));
    await get().loadGroups();
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

  /** 用邀请码加入群聊：加入后直接切过去（新用户第一次进群走这条路） */
  joinRoomByCode: async (code) => {
    const res = await apiClient.joinRoomByCode(code);
    set((state) => ({
      rooms: state.rooms.some((r) => r.id === res.room.id)
        ? state.rooms.map((r) => (r.id === res.room.id ? res.room : r))
        : [...state.rooms, res.room],
    }));
    await get().openRoom(res.room.id);
    return { room: res.room, alreadyMember: res.alreadyMember };
  },

  refreshRoom: async (roomId) => {
    const detail = await apiClient.room(roomId);
    set((state) => ({
      members: { ...state.members, [roomId]: detail.members },
      files: { ...state.files, [roomId]: detail.files },
      rooms: state.rooms.map((r) => (r.id === roomId ? detail.room : r)),
    }));
  },

  /**
   * 解散房间：服务端已经把消息/成员/文件/运行记录清掉，这里把本地缓存一并抹掉，
   * 并切到剩下的第一个房间（如果解散的正是当前打开的那个）。
   */
  dissolveRoom: async (roomId, opts = {}) => {
    const res = await apiClient.deleteRoom(roomId, opts);
    const wasActive = get().activeRoomId === roomId;
    set((state) => {
      const members = { ...state.members };
      const messages = { ...state.messages };
      const files = { ...state.files };
      const typing = { ...state.typing };
      delete members[roomId];
      delete messages[roomId];
      delete files[roomId];
      delete typing[roomId];
      const rooms = state.rooms.filter((r) => r.id !== roomId);
      return {
        rooms,
        members,
        messages,
        files,
        typing,
        activeRoomId: state.activeRoomId === roomId ? (rooms[0]?.id ?? null) : state.activeRoomId,
      };
    });
    log.action('解散房间', `${res.name}（消息 ${res.deleted?.messages ?? 0} 条 / 文件 ${res.deleted?.diskFiles ?? 0} 个）`);
    const next = get().activeRoomId;
    if (wasActive && next) await get().openRoom(next);
    return { name: res.name, hint: res.hint, filesKept: res.filesKept, deleted: res.deleted };
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

  /** 服务端全文检索：能搜到本地还没加载的更早消息 */
  searchMessages: async (roomId, query, limit = 50) => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const res = await apiClient.messages(roomId, { search: trimmed, limit });
    log.debug('搜索消息', { roomId, query: trimmed, hits: res.messages.length });
    return res.messages;
  },

  /**
   * 定位到某条历史消息：先把这条消息前后的一段上下文并进当前视图，
   * 再交给 MessageList 滚动 + 高亮（只加载这一段，不把整段历史拉下来）。
   */
  jumpToMessage: async (roomId, messageId) => {
    const res = await apiClient.messages(roomId, { before: messageId + 1, limit: 60 });
    set((state) => ({
      messages: { ...state.messages, [roomId]: mergeMessages(state.messages[roomId] ?? [], res.messages) },
      focusMessageId: messageId,
    }));
  },

  clearFocus: () => set({ focusMessageId: null }),

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
    if (!roomId) return {};
    const res = await apiClient.deleteFile(id);
    set((state) => ({
      files: { ...state.files, [roomId]: (state.files[roomId] ?? []).filter((f) => f.id !== id) },
    }));
    /* 聊天里那条附件消息被摘掉引用后要跟着更新（否则还挂着个下不动的附件） */
    if (res.detachedMessages) await get().refreshRoom(roomId);
    return res;
  },

  /** 批量删除共享文件：删完若聊天里的附件引用被清理过，就刷一次房间把消息同步过来 */
  removeFiles: async (ids) => {
    const roomId = get().activeRoomId;
    if (!roomId || !ids.length) return { deleted: [], failed: [] };
    const res = await apiClient.deleteFiles(roomId, ids);
    set((state) => ({
      files: {
        ...state.files,
        [roomId]: (state.files[roomId] ?? []).filter((f) => !res.deleted.includes(f.id)),
      },
    }));
    if (res.detachedMessages) await get().refreshRoom(roomId);
    return { deleted: res.deleted, failed: res.failed ?? [] };
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
      /* 消息被删除（心跳收尾、撤回等）：按 id 从列表里移除 */
      case 'message.deleted': {
        const data = event.data as { id: number };
        const roomId = event.roomId ?? '';
        if (!roomId || !data?.id) break;
        set((s) => ({
          messages: {
            ...s.messages,
            [roomId]: (s.messages[roomId] ?? []).filter((m) => m.id !== data.id),
          },
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
      /**
       * 在线状态：长连接的成员走连接数，外部客户端（external）没有长连接，
       * 由服务端按「最近有没有带 token 来拉消息」广播 presence，这里照样更新即可。
       */
      case 'presence': {
        const data = event.data as { tag: string; online: boolean; external?: boolean; lastSeenAt?: number };
        set((s) => {
          const next: Record<string, Member[]> = {};
          for (const [roomId, list] of Object.entries(s.members)) {
            next[roomId] = list.map((m) =>
              m.tag === data.tag
                ? {
                    ...m,
                    online: data.online,
                    external: data.external ?? m.external,
                    lastSeenAt: data.lastSeenAt ?? m.lastSeenAt,
                  }
                : m,
            );
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
      /* 成员变更：以前没人处理这些事件，所以"别人用邀请码进群后，成员列表要手动刷新才出现"。
         现在收到就重新拉一次房间详情（成员 + 文件 + 房间摘要），顺手把房间列表里的成员数也更新掉。 */
      case 'member.join':
      case 'member.leave':
      case 'room.update': {
        const roomId = event.roomId ?? '';
        if (!roomId) break;
        void get()
          .refreshRoom(roomId)
          .catch((err) => log.warn('刷新房间失败', err));
        break;
      }
      /* 别人改了分组（新建/改名/删除/把房间挪走）：本端刷新一次，侧栏立刻跟上 */
      case 'group.update': {
        void get()
          .loadGroups()
          .then(() => get().loadRooms())
          .catch((err) => log.warn('刷新分组失败', err));
        break;
      }
      /* 新建房间：别人把你拉进新群时，直接出现在你的房间列表里 */
      case 'room.created': {
        const room = event.data as RoomSummary;
        if (!room?.id) break;
        set((s) => ({
          rooms: s.rooms.some((r) => r.id === room.id) ? s.rooms.map((r) => (r.id === room.id ? room : r)) : [...s.rooms, room],
        }));
        log.info('有新房间', room.name);
        break;
      }
      case 'room.deleted': {
        const data = event.data as { id: string };
        set((s) => ({
          rooms: s.rooms.filter((r) => r.id !== data.id),
          activeRoomId: s.activeRoomId === data.id ? null : s.activeRoomId,
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
      groups: [],
      activeRoomId: null,
      messages: {},
      members: {},
      files: {},
      typing: {},
      error: null,
      focusMessageId: null,
    }),
}));

/** 页面加载时把持久化的 server/token 同步给 API 客户端 */
export function syncApiConfig(): void {
  const { server, token } = useSessionStore.getState();
  configureApi({ server, token });
}
