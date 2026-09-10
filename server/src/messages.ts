import {
  findRoom,
  getMessage,
  insertMessage,
  listRoomMemberTags,
  newId,
  now,
  parseJson,
  type MemberRow,
  type MessageRow,
} from './db.js';
import { HttpError } from './auth.js';
import { broadcast } from './hub.js';
import { hasAllMention, parseMentions } from './prompt.js';

export interface PostMessageInput {
  roomId: string;
  sender: Pick<MemberRow, 'tag' | 'nickname' | 'kind'> | null;
  text: string;
  type?: 'text' | 'file' | 'system';
  files?: string[];
  replyTo?: number | null;
  chainId?: string | null;
  hop?: number;
  meta?: Record<string, unknown>;
  /** 已知的成员 tag 集合，用于把 @xxx 收敛成真实成员 */
  knownTags?: Set<string>;
}

export function publicMessage(row: MessageRow): Record<string, unknown> {
  return {
    id: row.id,
    roomId: row.room_id,
    senderTag: row.sender_tag,
    senderNickname: row.sender_nickname,
    senderKind: row.sender_kind,
    type: row.type,
    text: row.text,
    mentions: parseJson<string[]>(row.mentions, []),
    files: parseJson<string[]>(row.files, []),
    replyTo: row.reply_to,
    chainId: row.chain_id,
    hop: row.hop,
    meta: parseJson<Record<string, unknown>>(row.meta, {}),
    createdAt: row.created_at,
  };
}

export function roomMemberTagSet(roomId: string): Set<string> {
  return new Set(listRoomMemberTags(roomId));
}

export function postMessage(input: PostMessageInput): MessageRow {
  const room = findRoom(input.roomId);
  if (!room) throw new HttpError(404, `房间 ${input.roomId} 不存在`);
  const text = String(input.text ?? '').slice(0, 20000);
  if (!text.trim() && !(input.files?.length)) {
    throw new HttpError(400, '消息内容为空');
  }
  const known = input.knownTags ?? roomMemberTagSet(input.roomId);
  const mentions = parseMentions(text, known);
  // @全体 不是成员 tag，单独用 meta 标记，路由时唤醒房间内所有 AI
  const meta: Record<string, unknown> = { ...(input.meta ?? {}) };
  if (hasAllMention(text)) meta.mentionAll = true;
  const sender = input.sender ?? { tag: 'system', nickname: '系统', kind: 'human' as const };
  const row: Omit<MessageRow, 'id'> = {
    room_id: input.roomId,
    sender_tag: sender.tag,
    sender_nickname: sender.nickname,
    sender_kind: input.type === 'system' ? 'system' : sender.kind,
    type: input.type ?? 'text',
    text,
    mentions: JSON.stringify(mentions),
    files: JSON.stringify(input.files ?? []),
    reply_to: input.replyTo ?? null,
    chain_id: input.chainId ?? null,
    hop: input.hop ?? 0,
    meta: JSON.stringify(meta),
    created_at: now(),
  };
  const saved = insertMessage(row);
  broadcast({
    type: 'message',
    roomId: input.roomId,
    data: publicMessage(saved),
    ts: saved.created_at,
  });
  return saved;
}

export function systemMessage(roomId: string, text: string, meta: Record<string, unknown> = {}): MessageRow {
  return postMessage({
    roomId,
    sender: { tag: 'system', nickname: '系统', kind: 'human' },
    text,
    type: 'system',
    meta,
  });
}

export function newChainId(): string {
  return newId('chain');
}

export function replyOf(messageId: number): MessageRow | undefined {
  return getMessage(messageId);
}
