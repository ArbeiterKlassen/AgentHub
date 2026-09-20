import {
  deleteMessage,
  findRoom,
  getMessage,
  insertMessage,
  listRoomMemberTags,
  listMessagesWithFile,
  newId,
  now,
  parseJson,
  updateMessageFiles,
  updateMessageText,
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
  /** 结构化载荷（任意 JSON 对象）：给机器读的部分放这儿，别让人从散文里抠数 */
  data?: Record<string, unknown>;
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
    data: parseJson<Record<string, unknown>>(row.data, {}),
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
  const data = input.data && typeof input.data === 'object' ? input.data : {};
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
    data: JSON.stringify(data),
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

/**
 * 原地更新一条系统消息（用于「长任务进度」这类心跳：同一条消息反复改写，而不是每 2 分钟刷一条新的）。
 * 客户端收到同样 id 的 message 事件会按 id 覆盖（store 里就是按 id 合并的），所以无需新增事件类型。
 */
export function updateSystemMessage(id: number, text: string, meta?: Record<string, unknown>): MessageRow | null {
  const updated = updateMessageText(id, text, meta);
  if (!updated) return null;
  broadcast({ type: 'message', roomId: updated.room_id, data: publicMessage(updated), ts: Date.now() });
  return updated;
}

/** 删除一条系统消息并广播（心跳在任务结束时收尾用） */
export function removeSystemMessage(id: number): void {
  const row = getMessage(id);
  if (!row) return;
  if (deleteMessage(id)) {
    broadcast({ type: 'message.deleted', roomId: row.room_id, data: { id }, ts: Date.now() });
  }
}

export function newChainId(): string {
  return newId('chain');
}

/**
 * 文件被删除后，把聊天里对它的引用摘掉：消息本身留着（历史不该凭空消失），
 * 但 files 里不再挂一个下载必 404 的 id，并打上 meta.fileDeleted 让界面显示「文件已删除」。
 * 返回受影响的消息条数。
 */
export function detachFileFromMessages(roomId: string, fileId: string): number {
  let affected = 0;
  for (const row of listMessagesWithFile(roomId, fileId)) {
    const files = parseJson<string[]>(row.files, []).filter((id) => id !== fileId);
    const meta = parseJson<Record<string, unknown>>(row.meta, {});
    const deleted = Array.isArray(meta.fileDeleted) ? (meta.fileDeleted as string[]) : [];
    meta.fileDeleted = [...new Set([...deleted, fileId])];
    const updated = updateMessageFiles(row.id, files, meta);
    if (updated) {
      broadcast({ type: 'message', roomId: updated.room_id, data: publicMessage(updated), ts: Date.now() });
      affected += 1;
    }
  }
  return affected;
}

export function replyOf(messageId: number): MessageRow | undefined {
  return getMessage(messageId);
}
