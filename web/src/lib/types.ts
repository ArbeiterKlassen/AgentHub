export type MemberKind = 'human' | 'agent';

export interface Member {
  tag: string;
  nickname: string;
  kind: MemberKind;
  agentKind: string | null;
  adapterId: string | null;
  avatar: string;
  color: string;
  role: 'admin' | 'member';
  triggerMode: 'mentions' | 'all' | 'manual';
  workdir: string | null;
  systemPrompt: string | null;
  createdAt?: number;
  lastSeenAt?: number | null;
  online?: boolean;
  status?: AgentStatus;
  statusDetail?: string | null;
  queue?: number;
}

export type AgentStatus = 'offline' | 'idle' | 'thinking' | 'error';

export interface RoomSummary {
  id: string;
  name: string;
  topic: string;
  meta: Record<string, unknown>;
  createdBy: string | null;
  createdAt: number;
  memberTags: string[];
  memberCount: number;
  agentCount: number;
  messageCount: number;
  lastMessage: ChatMessage | null;
  paused: boolean;
  isMember: boolean;
}

export interface ChatMessage {
  id: number;
  roomId: string;
  senderTag: string;
  senderNickname: string;
  senderKind: 'human' | 'agent' | 'system';
  type: 'text' | 'file' | 'system';
  text: string;
  mentions: string[];
  files: string[];
  replyTo: number | null;
  chainId: string | null;
  hop: number;
  meta: Record<string, unknown>;
  createdAt: number;
}

export interface SharedFile {
  id: string;
  roomId: string;
  name: string;
  size: number;
  mime: string | null;
  uploaderTag: string;
  sha256: string;
  createdAt: number;
  url: string;
  downloadUrl: string;
}

export interface AdapterInfo {
  id: string;
  label: string;
  description?: string;
  kind: 'cli' | 'http';
  command?: string;
  args?: string[];
  endpoint?: string;
  model?: string;
  available: boolean;
  probeDetail: string;
  unverified?: boolean;
  disabled?: boolean;
}

export interface RunRecord {
  id: string;
  roomId: string | null;
  agentTag: string;
  status: string;
  adapterId: string | null;
  exitCode: number | null;
  durationMs: number | null;
  error: string | null;
  chainId: string | null;
  hop: number;
  triggerMsg: number | null;
  createdAt: number;
  finishedAt: number | null;
  prompt?: string;
  output?: string;
}

export interface RealtimeEvent {
  type: string;
  roomId?: string | null;
  data: unknown;
  ts: number;
}
