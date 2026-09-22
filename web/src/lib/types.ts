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
  /** 外部客户端（adapter=external）：服务端不代跑，靠它自己轮询取消息 */
  external?: boolean;
  /** 外部客户端主动报的状态备注（POST /api/heartbeat） */
  presenceNote?: string | null;
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
  /** 群聊唯一识别码（邀请码）：显示给成员复制，别人凭它加入 */
  code: string;
  /** 所属分组 id（null = 未分组）：侧栏按它把房间分堆 */
  groupId?: string | null;
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

/** 群聊分组（侧栏里的「文件夹」）：挂在房间上，所有人看到同一套 */
export interface RoomGroup {
  id: string;
  name: string;
  sort: number;
  createdBy: string | null;
  createdAt: number;
  roomIds: string[];
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
  /** 结构化载荷：给机器读的部分（人看的仍在 text 里） */
  data?: Record<string, unknown>;
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
  /** 同名文件的第几版；previousId 指向上一条 */
  version?: number;
  previousId?: string | null;
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
  /** token 用量（CLI 自报；没报就是 null） */
  tokensIn?: number | null;
  tokensOut?: number | null;
  tokensTotal?: number | null;
  costUsd?: number | null;
  prompt?: string;
  output?: string;
}

export interface RealtimeEvent {
  type: string;
  roomId?: string | null;
  data: unknown;
  ts: number;
}
