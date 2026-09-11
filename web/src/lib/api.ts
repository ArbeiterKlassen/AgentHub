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

  patchRoom: (roomId: string, patch: Record<string, unknown>) =>
    api<{ room: RoomSummary }>(`/api/rooms/${encodeURIComponent(roomId)}`, { method: 'PATCH', body: patch }),

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

  deleteFile: (fileId: string) => api<{ ok: boolean }>(`/api/files/${fileId}`, { method: 'DELETE' }),

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
