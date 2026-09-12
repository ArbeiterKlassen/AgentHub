import type { AdapterInfo, ChatMessage, Member, RoomSummary, RunRecord, SharedFile } from './types';
import { log } from './logger';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface ApiConfig {
  server: string;
  token: string;
}

const DEFAULT_SERVER = (import.meta.env.VITE_AH_SERVER as string | undefined) ?? '';

let config: ApiConfig = { server: DEFAULT_SERVER, token: '' };

export function configureApi(next: Partial<ApiConfig>): void {
  config = { ...config, ...next };
}

export function getApiConfig(): ApiConfig {
  return config;
}

/** 默认同源（后端托管前端时），也支持指向别的地址 */
export function resolveServer(server: string): string {
  const value = (server || DEFAULT_SERVER || '').trim().replace(/\/+$/, '');
  if (!value) return window.location.origin;
  return value;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  raw?: BodyInit;
  headers?: Record<string, string>;
  auth?: boolean;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, raw, headers = {}, auth = true, signal } = options;
  const url = `${resolveServer(config.server)}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(auth && config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    signal,
  });
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const message = (data as { error?: string })?.error ?? `${res.status} ${res.statusText}`;
    log.warn('API 失败', { path, status: res.status, message });
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export interface RegisterInput {
  tag: string;
  nickname: string;
  kind: 'human' | 'agent';
  adapterId?: string;
  agentKind?: string;
  avatar?: string;
  color?: string;
  workdir?: string;
  systemPrompt?: string;
  triggerMode?: 'mentions' | 'all' | 'manual';
}

export const apiClient = {
  health: () =>
    api<{
      ok: boolean;
      node: string;
      version: string;
      adapters: AdapterInfo[];
      lanUrls?: string[];
    }>('/api/health', { auth: false }),

  register: (input: RegisterInput) =>
    api<{ member: Member; token: string }>('/api/register', { method: 'POST', body: input, auth: false }),

  login: (tag: string, token: string) =>
    api<{ member: Member; token: string }>('/api/login', { method: 'POST', body: { tag, token }, auth: false }),

  me: () => api<{ member: Member & { token: string }; rooms: RoomSummary[] }>('/api/me'),

  members: () => api<{ members: Member[] }>('/api/members'),

  adapters: () => api<{ adapters: AdapterInfo[]; platform: string; repoRoot: string }>('/api/adapters'),

  patchMember: (tag: string, patch: Record<string, unknown>) =>
    api<{ member: Member }>(`/api/members/${tag}`, { method: 'PATCH', body: patch }),

  memberToken: (tag: string) => api<{ tag: string; token: string }>(`/api/members/${tag}/token`),

  rotateToken: (tag: string) => api<{ tag: string; token: string }>(`/api/members/${tag}/token`, { method: 'POST' }),

  deleteMember: (tag: string, force = false) =>
    api<{ ok: boolean; removed: string }>(`/api/members/${tag}${force ? '?force=1' : ''}`, { method: 'DELETE' }),

  rooms: () => api<{ rooms: RoomSummary[] }>('/api/rooms'),

  room: (roomId: string) =>
    api<{ room: RoomSummary; members: Member[]; files: SharedFile[] }>(`/api/rooms/${encodeURIComponent(roomId)}`),

  createRoom: (input: { name: string; topic?: string; members?: string[] }) =>
    api<{ room: RoomSummary }>('/api/rooms', { method: 'POST', body: input }),

  /** 用邀请码加入群聊（任何已注册用户都能调） */
  joinRoomByCode: (code: string) =>
    api<{ ok: boolean; alreadyMember: boolean; room: RoomSummary }>('/api/rooms/join', {
      method: 'POST',
      body: { code },
    }),

  rotateRoomCode: (roomId: string) =>
    api<{ ok: boolean; roomId: string; code: string }>(
      `/api/rooms/${encodeURIComponent(roomId)}/code/rotate`,
      { method: 'POST' },
    ),

  patchRoom: (roomId: string, patch: Record<string, unknown>) =>
    api<{ room: RoomSummary }>(`/api/rooms/${encodeURIComponent(roomId)}`, { method: 'PATCH', body: patch }),

  /**
   * 解散房间：群主可解散自己建的房间，管理员可解散任意房间。
   * 默认连磁盘上的共享文件一起彻底删除；keepFiles 时只删房间与聊天记录、文件留在磁盘上。
   */
  deleteRoom: (roomId: string, opts: { keepFiles?: boolean } = {}) =>
    api<{
      ok: boolean;
      removed: string;
      name: string;
      deleted: { members: number; messages: number; files: number; runs: number; diskFiles: number; queuedJobs: number };
      freedBytes: number;
      filesDir: string;
      filesKept: boolean;
      hint: string;
    }>(`/api/rooms/${encodeURIComponent(roomId)}${opts.keepFiles ? '?keepFiles=1' : ''}`, { method: 'DELETE' }),

  addMember: (roomId: string, tag: string) =>
    api<{ ok: boolean; members: string[] }>(`/api/rooms/${encodeURIComponent(roomId)}/members`, {
      method: 'POST',
      body: { tag },
    }),

  removeMember: (roomId: string, tag: string) =>
    api<{ ok: boolean; members: string[] }>(
      `/api/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(tag)}`,
      { method: 'DELETE' },
    ),

  messages: (roomId: string, params: { limit?: number; before?: number; after?: number; search?: string } = {}) => {
    const query = new URLSearchParams();
    query.set('limit', String(params.limit ?? 100));
    if (params.before) query.set('before', String(params.before));
    if (params.after) query.set('after', String(params.after));
    if (params.search) query.set('search', params.search);
    return api<{ messages: ChatMessage[]; count: number }>(
      `/api/rooms/${encodeURIComponent(roomId)}/messages?${query}`,
    );
  },

  sendMessage: (
    roomId: string,
    input: { text: string; files?: string[]; replyTo?: number | null; chainId?: string | null; hop?: number },
  ) =>
    api<{ message: ChatMessage; queued?: number; control?: string }>(
      `/api/rooms/${encodeURIComponent(roomId)}/messages`,
      { method: 'POST', body: input },
    ),

  deleteMessage: (roomId: string, id: number) =>
    api<{ ok: boolean }>(`/api/rooms/${encodeURIComponent(roomId)}/messages/${id}`, { method: 'DELETE' }),

  uploadFile: (roomId: string, file: File) =>
    api<{ file: SharedFile; message: ChatMessage; queued: number }>(
      `/api/rooms/${encodeURIComponent(roomId)}/files`,
      {
        method: 'POST',
        raw: file,
        headers: { 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream' },
      },
    ),

  deleteFile: (fileId: string) =>
    api<{ ok: boolean; detachedMessages?: number; hint?: string }>(`/api/files/${fileId}`, { method: 'DELETE' }),

  /** 批量删除共享文件（只删得掉自己有权限的那些，其余在 failed 里给原因） */
  deleteFiles: (roomId: string, ids: string[]) =>
    api<{ ok: boolean; deleted: string[]; failed: Array<{ id: string; error: string }>; detachedMessages: number }>(
      `/api/rooms/${encodeURIComponent(roomId)}/files/delete`,
      { method: 'POST', body: { ids } },
    ),

  agents: (roomId: string) => api<{ agents: Member[] }>(`/api/rooms/${encodeURIComponent(roomId)}/agents`),

  speak: (roomId: string, tag: string) =>
    api<{ ok: boolean }>(`/api/rooms/${encodeURIComponent(roomId)}/agents/${tag}/speak`, { method: 'POST' }),

  discuss: (roomId: string, input: { topic: string; tags: string[]; rounds: number }) =>
    api<{ ok: boolean }>(`/api/rooms/${encodeURIComponent(roomId)}/discuss`, { method: 'POST', body: input }),

  control: (roomId: string, action: 'pause' | 'resume' | 'stop') =>
    api<{ ok: boolean; paused?: boolean; dropped?: number }>(`/api/rooms/${encodeURIComponent(roomId)}/control`, {
      method: 'POST',
      body: { action },
    }),

  runs: (tag: string, limit = 20) => api<{ runs: RunRecord[] }>(`/api/agents/${tag}/runs?limit=${limit}`),

  run: (tag: string, id: string) => api<{ run: RunRecord }>(`/api/agents/${tag}/runs/${id}`),

  status: () =>
    api<{ runtime: Record<string, unknown>; orchestrator: Record<string, unknown> }>('/api/status'),
};

export function downloadUrl(server: string, fileId: string, token: string, download = true): string {
  const base = resolveServer(server);
  const query = new URLSearchParams({ token, ...(download ? { download: '1' } : {}) });
  return `${base}/api/files/${fileId}?${query}`;
}

/** 导出聊天记录的直链（带 token，点一下就能下载成 .md / .json） */
export function exportUrl(
  server: string,
  roomId: string,
  format: 'md' | 'json',
  opts: { limit?: number; search?: string; sender?: string; includeSystem?: boolean } = {},
): string {
  const base = resolveServer(server);
  const query = new URLSearchParams({ format, token: config.token });
  if (opts.limit) query.set('limit', String(opts.limit));
  if (opts.search) query.set('search', opts.search);
  if (opts.sender) query.set('sender', opts.sender);
  if (opts.includeSystem === false) query.set('system', '0');
  return `${base}/api/rooms/${encodeURIComponent(roomId)}/export?${query}`;
}

/** 直接用 <a download> 触发下载（走 GET + query token，不占内存拼字符串） */
export function downloadRoomExport(
  server: string,
  roomId: string,
  roomName: string,
  format: 'md' | 'json',
  opts: { limit?: number; search?: string } = {},
): void {
  const a = document.createElement('a');
  a.href = exportUrl(server, roomId, format, opts);
  a.download = `AgentHub-${roomName}.${format}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
