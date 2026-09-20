export type AgentStatus = 'offline' | 'idle' | 'thinking' | 'error';

export interface HubEvent {
  type:
    | 'hello'
    | 'message'
    | 'message.deleted'
    | 'member.join'
    | 'member.leave'
    | 'member.update'
    | 'presence'
    | 'agent.status'
    | 'room.created'
    | 'room.update'
    | 'room.deleted'
    | 'file.add'
    | 'file.remove'
    | 'typing'
    | 'system';
  roomId?: string | null;
  data: unknown;
  ts: number;
}

type Sender = (event: HubEvent) => void;

interface Subscriber {
  id: number;
  tag: string | null;
  rooms: Set<string>;
  /** 未显式订阅房间时用于动态判断是否有权限（例如连接后又创建了新房间） */
  filter?: (roomId: string) => boolean;
  send: Sender;
}

let seq = 0;
const subscribers = new Map<number, Subscriber>();
const presence = new Map<string, number>();
const agentStatus = new Map<string, { status: AgentStatus; detail?: string; ts: number }>();
const queueDepth = new Map<string, number>();
/** 外部客户端可以主动报一句状态（"我在，只是忙"）——比"最近活跃"更能说明问题 */
const presenceNotes = new Map<string, { note: string; ts: number }>();
const startedAt = Date.now();

export function subscribe(
  send: Sender,
  opts: { tag?: string | null; rooms?: string[]; filter?: (roomId: string) => boolean } = {},
): number {
  const id = ++seq;
  subscribers.set(id, {
    id,
    tag: opts.tag ?? null,
    rooms: new Set(opts.rooms ?? []),
    filter: opts.filter,
    send,
  });
  if (opts.tag) bumpPresence(opts.tag, 1);
  return id;
}

export function unsubscribe(id: number): void {
  const sub = subscribers.get(id);
  if (!sub) return;
  subscribers.delete(id);
  if (sub.tag) bumpPresence(sub.tag, -1);
}

export function watchRoom(id: number, roomId: string): void {
  subscribers.get(id)?.rooms.add(roomId);
}

function bumpPresence(tag: string, delta: number): void {
  const next = Math.max(0, (presence.get(tag) ?? 0) + delta);
  if (next === 0) presence.delete(tag);
  else presence.set(tag, next);
  broadcast({ type: 'presence', data: { tag, online: next > 0 }, ts: Date.now() });
}

export function isOnline(tag: string): boolean {
  return (presence.get(tag) ?? 0) > 0;
}

export function onlineTags(): string[] {
  return [...presence.keys()];
}

export function broadcast(event: HubEvent): void {
  for (const sub of subscribers.values()) {
    if (event.roomId) {
      // 语义：rooms 是静态白名单，filter 是动态谓词，两者同时存在时取「交集」。
      // 不能写成 if/else —— 一旦 rooms 非空就跳过 filter，调用方不小心两者都传时，
      // 「连接之后才创建/加入的房间」会被静态快照挡掉、动态判定沦为死代码（历史缺陷）。
      if (sub.rooms.size > 0 && !sub.rooms.has(event.roomId)) continue;
      if (sub.filter && !sub.filter(event.roomId)) continue;
    }
    try {
      sub.send(event);
    } catch {
      /* 断开的连接会在 ws 层自行清理 */
    }
  }
}

export function setAgentStatus(tag: string, status: AgentStatus, detail?: string): void {
  const current = agentStatus.get(tag);
  if (current && current.status === status && current.detail === detail) return;
  agentStatus.set(tag, { status, detail, ts: Date.now() });
  broadcast({
    type: 'agent.status',
    data: { tag, status, detail: detail ?? null, queue: queueDepth.get(tag) ?? 0 },
    ts: Date.now(),
  });
}

export function getAgentStatus(tag: string): { status: AgentStatus; detail?: string } {
  return agentStatus.get(tag) ?? { status: 'offline' };
}

export function setQueueDepth(tag: string, depth: number): void {
  queueDepth.set(tag, depth);
  broadcast({
    type: 'agent.status',
    data: { tag, status: getAgentStatus(tag).status, detail: getAgentStatus(tag).detail ?? null, queue: depth },
    ts: Date.now(),
  });
}

export function runtimeSnapshot(): Record<string, unknown> {
  return {
    startedAt,
    uptimeMs: Date.now() - startedAt,
    subscribers: subscribers.size,
    online: onlineTags(),
    agents: Object.fromEntries(
      [...agentStatus.entries()].map(([tag, v]) => [
        tag,
        { status: v.status, detail: v.detail ?? null, queue: queueDepth.get(tag) ?? 0 },
      ]),
    ),
  };
}

/**
 * 成员被删除后清掉它的在线状态与排队数。
 * 不清的话 /api/status 会一直挂着这些「幽灵 AI」（ID 都删了，状态还在），
 * 排查问题时很容易被误导成「还有任务在跑」。
 */
export function clearAgentPresence(tag: string): void {
  agentStatus.delete(tag);
  queueDepth.delete(tag);
  presenceNotes.delete(tag);
}

/** 外部客户端主动上报的状态备注（例如「在跑评测，预计 20 分钟」） */
export function setPresenceNote(tag: string, note: string | null): void {
  if (note && note.trim()) presenceNotes.set(tag, { note: note.trim().slice(0, 120), ts: Date.now() });
  else presenceNotes.delete(tag);
}

export function getPresenceNote(tag: string): string | null {
  return presenceNotes.get(tag)?.note ?? null;
}
