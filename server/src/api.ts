import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';
import {
  addRoomMember,
  deleteMember,
  findMember,
  findRoom,
  findRoomByCode,
  findRoomByName,
  generateRoomCode,
  getDb,
  getFile,
  getMessage,
  getRun,
  insertRoom,
  isRoomMember,
  listMembers,
  listMessages,
  listRooms,
  listRoomMemberTags,
  listRuns,
  memberMessageCount,
  memberRoomCount,
  newId,
  now,
  parseJson,
  removeRoomMember,
  rotateRoomCode,
  roomMessageCount,
  updateMember,
  updateRoom,
  type MemberRow,
  type RoomRow,
} from './db.js';
import {
  HttpError,
  createToken,
  publicMember,
  registerMember,
  requireAuth,
  requireAdmin,
  assertTag,
} from './auth.js';
import { loadAdapters, probeAll } from './adapters.js';
import { handleDownload, handleUpload, listRoomFiles, publicFile, removeFile } from './files.js';
import { publicMessage, postMessage, roomMemberTagSet, systemMessage } from './messages.js';
import { broadcast, getAgentStatus, isOnline, runtimeSnapshot, subscribe, unsubscribe } from './hub.js';
import {
  DEFAULT_ROOM_META,
  isPaused,
  orchestratorStatus,
  pauseRoom,
  promptForAgent,
  resumeRoom,
  routeMessage,
  speakNow,
  startDiscussion,
  stopRoom,
} from './orchestrator.js';
import { parseMentions } from './prompt.js';
import { sha256 } from './db.js';
import { PORT, REPO_ROOT, lanAddresses } from './env.js';

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;

const wrap =
  (fn: Handler) =>
  (req: Request, res: Response): void => {
    const fail = (err: unknown): void => {
      if (res.headersSent) return;
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status >= 500) console.error('[api] 未处理错误', err);
      res.status(status).json({ error: message });
    };
    try {
      // 注意：fn 里大量使用同步 throw（throw new HttpError(...)），必须先 try 住这一次调用，
      // 否则同步异常会绕过下面的 .catch，被 Express 的默认错误处理捞走，返回 HTML 错误页而不是 JSON。
      Promise.resolve(fn(req, res))
        .then((result) => {
          if (result !== undefined && !res.headersSent) res.json(result);
        })
        .catch(fail);
    } catch (err) {
      fail(err);
    }
  };

function resolveRoom(param: string): RoomRow {
  const room = findRoom(param) ?? findRoomByName(param);
  if (!room) throw new HttpError(404, `房间「${param}」不存在`);
  return room;
}

function requireRoomMember(req: Request, roomId: string): MemberRow {
  const member = requireAuth(req);
  if (!isRoomMember(roomId, member.tag) && member.role !== 'admin') {
    throw new HttpError(403, '你不是该房间成员');
  }
  return member;
}

function originOf(req: Request): string {
  const host = req.headers.host ?? '127.0.0.1:8787';
  return `${req.protocol}://${host}`;
}

/** 自己、管理员，或者与该 AI 同处一个房间的成员，都可以查看它的运行记录 */
function canViewRuns(me: MemberRow, tag: string): boolean {
  if (tag === me.tag || me.role === 'admin') return true;
  const target = findMember(tag);
  if (!target || target.kind !== 'agent') return false;
  return sharedRoom(me.tag, tag);
}

function sharedRoom(a: string, b: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS ok FROM room_members x
       JOIN room_members y ON x.room_id = y.room_id
       WHERE x.tag = ? AND y.tag = ? LIMIT 1`,
    )
    .get(a, b) as { ok: number } | undefined;
  return Boolean(row);
}

export function buildApiRouter(): Router {
  const api = express.Router();

  /* ------------------------------- 身份 ------------------------------- */

  api.post(
    '/register',
    wrap((req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { member, token } = registerMember({
        tag: String(body.tag ?? ''),
        nickname: typeof body.nickname === 'string' ? body.nickname : undefined,
        kind: body.kind === 'agent' ? 'agent' : 'human',
        agentKind: typeof body.agentKind === 'string' ? body.agentKind : undefined,
        adapterId: typeof body.adapterId === 'string' ? body.adapterId : undefined,
        avatar: typeof body.avatar === 'string' ? body.avatar : undefined,
        color: typeof body.color === 'string' ? body.color : undefined,
        workdir: typeof body.workdir === 'string' ? body.workdir : undefined,
        systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : undefined,
        triggerMode:
          body.triggerMode === 'all' || body.triggerMode === 'manual'
            ? (body.triggerMode as 'all' | 'manual')
            : body.triggerMode === 'mentions'
              ? 'mentions'
              : undefined,
        token: typeof body.token === 'string' ? body.token : undefined,
      });
      res.status(201);
      return { member: publicMember(member), token, dashboard: `/` };
    }),
  );

  api.post(
    '/login',
    wrap((req) => {
      const body = (req.body ?? {}) as { tag?: string; token?: string };
      const tag = assertTag(String(body.tag ?? ''));
      const member = findMember(tag);
      if (!member) throw new HttpError(404, `没有找到 tag「${tag}」`);
      if (!body.token || sha256(body.token) !== member.token_hash) {
        throw new HttpError(401, '登录 token 不正确');
      }
      return { member: publicMember(member), token: member.token_secret };
    }),
  );

  api.get('/me', wrap((req) => {
    const member = requireAuth(req);
    return {
      member: { ...publicMember(member), token: member.token_secret },
      rooms: listRooms()
        .filter((room) => isRoomMember(room.id, member.tag) || member.role === 'admin')
        .map((room) => roomSummary(room, member.tag, req)),
    };
  }));

  api.get('/members', wrap(() => ({ members: listMembers().map(publicMember) })));

  /** 查看某个成员的登录 token（自己或管理员）：用于生成 CLI 登录/启动命令 */
  api.get(
    '/members/:tag/token',
    wrap((req) => {
      const me = requireAuth(req);
      const tag = assertTag(req.params.tag);
      if (tag !== me.tag && me.role !== 'admin') throw new HttpError(403, '只能查看自己的 token');
      const target = findMember(tag);
      if (!target) throw new HttpError(404, `成员 @${tag} 不存在`);
      return { tag, token: target.token_secret };
    }),
  );

  api.patch(
    '/members/:tag',
    wrap((req) => {
      const me = requireAuth(req);
      const tag = assertTag(req.params.tag);
      if (tag !== me.tag && me.role !== 'admin') throw new HttpError(403, '只能修改自己的资料');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const key of ['nickname', 'avatar', 'color', 'workdir', 'system_prompt']) {
        if (typeof body[key] === 'string') patch[key] = body[key];
      }
      if (typeof body.triggerMode === 'string') patch.trigger_mode = body.triggerMode;
      if (typeof body.adapterId === 'string') patch.adapter_id = body.adapterId;
      if (typeof body.agentKind === 'string') patch.agent_kind = body.agentKind;
      if (typeof body.systemPrompt === 'string') patch.system_prompt = body.systemPrompt;
      updateMember(tag, patch);
      return { member: publicMember(findMember(tag)!) };
    }),
  );

  api.post(
    '/members/:tag/token',
    wrap((req) => {
      const me = requireAuth(req);
      const tag = assertTag(req.params.tag);
      if (tag !== me.tag && me.role !== 'admin') throw new HttpError(403, '只能重置自己的 token');
      const token = createToken();
      updateMember(tag, { meta: findMember(tag)?.meta ?? '{}' });
      // token_hash / token_secret 不在 updateMember 白名单里，直接写库
      const db = getDb();
      db.prepare('UPDATE members SET token_hash = ?, token_secret = ? WHERE tag = ?').run(
        sha256(token),
        token,
        tag,
      );
      return { tag, token };
    }),
  );

  /**
   * 删除成员（仅管理员）。默认拒绝删除「还在房间里或有发言」的成员，避免误删真人在用的身份；
   * 确认要删（例如清理测试账号）时加 ?force=1。
   */
  api.delete(
    '/members/:tag',
    wrap((req) => {
      const me = requireAdmin(req);
      const tag = assertTag(req.params.tag);
      if (tag === me.tag) throw new HttpError(400, '不能删除自己');
      const target = findMember(tag);
      if (!target) throw new HttpError(404, `成员 @${tag} 不存在`);
      const rooms = memberRoomCount(tag);
      const messages = memberMessageCount(tag);
      const force = req.query.force === '1' || req.query.force === 'true';
      if (!force && (rooms > 0 || messages > 0)) {
        throw new HttpError(
          409,
          `@${tag} 仍在 ${rooms} 个房间里、有 ${messages} 条发言，不像是空号。确认要删就加 ?force=1（消息记录会保留）`,
        );
      }
      deleteMember(tag);
      return { ok: true, removed: tag, rooms, messages };
    }),
  );

  /* ------------------------------ 适配器 ------------------------------ */

  api.get(
    '/adapters',
    wrap(async (req) => {
      const probes = await probeAll();
      const map = new Map(probes.map((p) => [p.id, p]));
      const adapters = loadAdapters().map((a) => ({
        ...a,
        available: map.get(a.id)?.available ?? false,
        probeDetail: map.get(a.id)?.detail ?? '',
      }));
      return { adapters, platform: process.platform, repoRoot: REPO_ROOT, cwd: process.cwd() };
    }),
  );

  /* -------------------------------- 房间 ------------------------------- */

  function roomSummary(room: RoomRow, viewerTag: string | null, req: Request): Record<string, unknown> {
    const tags = listRoomMemberTags(room.id);
    const last = listMessages({ roomId: room.id, limit: 1 });
    return {
      id: room.id,
      name: room.name,
      topic: room.topic,
      // 群聊唯一识别码（邀请码）：给成员显示/复制，别人用它加入
      code: room.code,
      meta: { ...DEFAULT_ROOM_META, ...parseJson<Record<string, unknown>>(room.meta, {}) },
      createdBy: room.created_by,
      createdAt: room.created_at,
      memberTags: tags,
      memberCount: tags.length,
      agentCount: tags.filter((t) => findMember(t)?.kind === 'agent').length,
      messageCount: roomMessageCount(room.id),
      lastMessage: last.length ? publicMessage(last[0]) : null,
      paused: isPaused(room.id),
      isMember: viewerTag ? tags.includes(viewerTag) : false,
      online: isOnline(viewerTag ?? ''),
      origin: originOf(req),
    };
  }

  api.get(
    '/rooms',
    wrap((req) => {
      const me = requireAuth(req);
      const rooms = listRooms().filter(
        (room) => isRoomMember(room.id, me.tag) || me.role === 'admin',
      );
      return { rooms: rooms.map((room) => roomSummary(room, me.tag, req)) };
    }),
  );

  api.post(
    '/rooms',
    wrap((req) => {
      const me = requireAuth(req);
      const body = (req.body ?? {}) as {
        name?: string;
        topic?: string;
        members?: string[];
        meta?: Record<string, unknown>;
      };
      const rawName = String(body.name ?? '').trim();
      if (!rawName) throw new HttpError(400, '房间名不能为空');
      if (findRoomByName(rawName)) throw new HttpError(409, `房间「${rawName}」已存在`);
      const id = newId('r');
      const room: RoomRow = {
        id,
        name: rawName.slice(0, 40),
        topic: String(body.topic ?? '').slice(0, 200),
        created_by: me.tag,
        meta: JSON.stringify({ ...DEFAULT_ROOM_META, ...(body.meta ?? {}) }),
        created_at: now(),
        code: generateRoomCode(),
      };
      const db = getDb();
      // 邀请码极小概率撞车，撞了就换一个再插
      for (let attempt = 0; ; attempt += 1) {
        try {
          insertRoom(room);
          break;
        } catch (err) {
          if (attempt >= 5) throw err;
          room.code = generateRoomCode();
        }
      }
      addRoomMember(room.id, me.tag, 'owner');
      const extras = Array.isArray(body.members) ? body.members : [];
      for (const tag of extras) {
        const target = findMember(String(tag).toLowerCase());
        if (target) addRoomMember(room.id, target.tag, 'member');
      }
      systemMessage(room.id, `房间「${room.name}」已创建，创建者 @${me.tag}`);
      // 让被拉进新房间的成员客户端立刻看到它（否则要刷新页面才出现）
      broadcast({ type: 'room.created', roomId: room.id, data: roomSummary(room, me.tag, req), ts: Date.now() });
      return { room: roomSummary(room, me.tag, req) };
    }),
  );

  api.get(
    '/rooms/:room',
    wrap((req) => {
      const me = requireAuth(req);
      const room = resolveRoom(req.params.room);
      requireRoomMember(req, room.id);
      const tags = listRoomMemberTags(room.id);
      return {
        room: roomSummary(room, me.tag, req),
        members: tags
          .map((tag) => findMember(tag))
          .filter((m): m is MemberRow => Boolean(m))
          .map((m) => ({
            ...publicMember(m),
            online: isOnline(m.tag),
            status: getAgentStatus(m.tag).status,
            statusDetail: getAgentStatus(m.tag).detail ?? null,
          })),
        files: listRoomFiles(room.id, originOf(req)),
      };
    }),
  );

  /**
   * 用邀请码加入群聊：**任何已注册用户都能调用**（这是新用户进群的唯一入口，
   * 不要求调用者已经是该房间成员）。码大小写不敏感，空格/短横线会被忽略。
   */
  api.post(
    '/rooms/join',
    wrap((req) => {
      const me = requireAuth(req);
      const body = (req.body ?? {}) as { code?: string };
      const raw = String(body.code ?? '');
      if (!raw.trim()) throw new HttpError(400, '请填写群聊邀请码');
      const room = findRoomByCode(raw);
      if (!room) throw new HttpError(404, `邀请码「${raw.trim()}」无效或已被重置，找群主确认一下`);
      const already = isRoomMember(room.id, me.tag);
      if (!already) {
        addRoomMember(room.id, me.tag, 'member');
        // 推送给房间里已有的客户端：成员列表要立刻能看到新成员（以前只能手动刷新）
        broadcast({
          type: 'member.join',
          roomId: room.id,
          data: { member: publicMember(me), via: 'invite-code' },
          ts: Date.now(),
        });
        systemMessage(room.id, `@${me.tag}（${me.nickname}）通过邀请码加入了房间`, {
          kind: 'member.join',
          tag: me.tag,
          via: 'invite-code',
        });
      }
      return { ok: true, alreadyMember: already, room: roomSummary(room, me.tag, req) };
    }),
  );

  /** 重置邀请码（群主或管理员）：旧码立即失效 */
  api.post(
    '/rooms/:room/code/rotate',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      const me = requireAuth(req);
      const isOwner = room.created_by === me.tag;
      if (!isOwner && me.role !== 'admin') throw new HttpError(403, '只有群主或管理员可以重置邀请码');
      const code = rotateRoomCode(room.id);
      systemMessage(room.id, `@${me.tag} 重置了本群邀请码，旧邀请码已失效`, {
        kind: 'room.code.rotate',
        level: 'info',
      });
      return { ok: true, roomId: room.id, code };
    }),
  );

  api.patch(
    '/rooms/:room',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      const me = requireRoomMember(req, room.id);
      const body = (req.body ?? {}) as { name?: string; topic?: string; meta?: Record<string, unknown> };
      const patch: Record<string, unknown> = {};
      if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 40);
      if (typeof body.topic === 'string') patch.topic = body.topic.slice(0, 200);
      if (body.meta) patch.meta = JSON.stringify({ ...roomMetaOf(room), ...body.meta });
      updateRoom(room.id, patch);
      systemMessage(room.id, `@${me.tag} 更新了房间信息`);
      return { room: roomSummary(findRoom(room.id)!, me.tag, req) };
    }),
  );

  api.delete(
    '/rooms/:room',
    wrap((req) => {
      requireAdmin(req);
      const room = resolveRoom(req.params.room);
      const db = getDb();
      db.prepare('DELETE FROM room_members WHERE room_id = ?').run(room.id);
      db.prepare('DELETE FROM messages WHERE room_id = ?').run(room.id);
      db.prepare('DELETE FROM files WHERE room_id = ?').run(room.id);
      db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
      broadcast({ type: 'room.deleted', roomId: room.id, data: { id: room.id }, ts: Date.now() });
      return { ok: true, removed: room.id };
    }),
  );

  api.post(
    '/rooms/:room/members',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      requireRoomMember(req, room.id);
      const body = (req.body ?? {}) as { tag?: string };
      const tag = assertTag(String(body.tag ?? ''));
      const target = findMember(tag);
      if (!target) throw new HttpError(404, `成员 @${tag} 不存在，请先注册/创建`);
      addRoomMember(room.id, tag);
      broadcast({
        type: 'member.join',
        roomId: room.id,
        data: { member: publicMember(target), via: 'manual' },
        ts: Date.now(),
      });
      systemMessage(room.id, `@${tag}（${target.nickname}）加入了房间`, { kind: 'member.join', tag });
      return { ok: true, members: listRoomMemberTags(room.id) };
    }),
  );

  api.delete(
    '/rooms/:room/members/:tag',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      const me = requireRoomMember(req, room.id);
      const tag = assertTag(req.params.tag);
      if (tag !== me.tag && me.role !== 'admin') throw new HttpError(403, '只能移除自己或由管理员执行');
      removeRoomMember(room.id, tag);
      broadcast({ type: 'member.leave', roomId: room.id, data: { tag }, ts: Date.now() });
      systemMessage(room.id, `@${tag} 离开了房间`, { kind: 'member.leave', tag });
      return { ok: true, members: listRoomMemberTags(room.id) };
    }),
  );

  /* ------------------------------- 消息 ------------------------------- */

  api.get(
    '/rooms/:room/messages',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      requireRoomMember(req, room.id);
      const q = req.query;
      const rows = listMessages({
        roomId: room.id,
        limit: Number(q.limit ?? 50),
        before: q.before ? Number(q.before) : undefined,
        after: q.after ? Number(q.after) : undefined,
        search: typeof q.search === 'string' ? q.search : undefined,
        sender: typeof q.sender === 'string' ? q.sender : undefined,
      });
      return {
        room: { id: room.id, name: room.name, topic: room.topic },
        count: rows.length,
        messages: rows.map(publicMessage),
      };
    }),
  );

  api.post(
    '/rooms/:room/messages',
    wrap(async (req, res) => {
      const room = resolveRoom(req.params.room);
      const me = requireRoomMember(req, room.id);
      const body = (req.body ?? {}) as {
        text?: string;
        files?: string[];
        replyTo?: number;
        chainId?: string;
        hop?: number;
        meta?: Record<string, unknown>;
        senderTag?: string;
        asTag?: string;
      };
      const text = String(body.text ?? '');
      const command = parseCommand(text);
      const overrideTag = (body.senderTag ?? body.asTag ?? '').toLowerCase();
      let sender: MemberRow = me;
      if (overrideTag && overrideTag !== me.tag) {
        // 边缘运行器：允许用同一个 token 以别的身份发言（仅限 AI 成员，便于本地代理）
        const target = findMember(overrideTag);
        if (!target) throw new HttpError(404, `成员 @${overrideTag} 不存在`);
        const allowed =
          me.role === 'admin' ||
          (target.kind === 'agent' && me.kind === 'agent' && target.adapter_id === me.adapter_id);
        if (!allowed) throw new HttpError(403, `无权以 @${overrideTag} 的身份发言`);
        sender = target;
      }

      const row = postMessage({
        roomId: room.id,
        sender,
        text,
        files: Array.isArray(body.files) ? body.files.slice(0, 10) : [],
        replyTo: body.replyTo ?? null,
        chainId: body.chainId ?? null,
        hop: Number.isFinite(body.hop) ? Number(body.hop) : 0,
        meta: { ...(body.meta ?? {}), ...(command ? { command: true, noRoute: true } : {}) },
      });

      let commandResult: Record<string, unknown> | null = null;
      if (command) {
        commandResult = await runCommand(req, room.id, command, me);
      } else {
        const queued = routeMessage(row);
        commandResult = { queued };
      }
      res.status(201);
      return { message: publicMessage(row), ...commandResult };
    }),
  );

  api.delete(
    '/rooms/:room/messages/:id',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      const me = requireRoomMember(req, room.id);
      const row = getMessage(Number(req.params.id));
      if (!row || row.room_id !== room.id) throw new HttpError(404, '消息不存在');
      if (row.sender_tag !== me.tag && me.role !== 'admin') throw new HttpError(403, '只能删除自己的消息');
      const db = getDb();
      db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
      return { ok: true, id: row.id };
    }),
  );

  /* ----------------------- AI 成员 / 讨论 / 控制 ----------------------- */

  api.get(
    '/rooms/:room/agents',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      requireRoomMember(req, room.id);
      const tags = listRoomMemberTags(room.id);
      const agents = tags
        .map((tag) => findMember(tag))
        .filter((m): m is MemberRow => Boolean(m) && m!.kind === 'agent')
        .map((m) => ({
          ...publicMember(m),
          online: isOnline(m.tag),
          ...getAgentStatus(m.tag),
          runs: listRuns(m.tag, 5).map(publicRun),
        }));
      return { agents };
    }),
  );

  api.get(
    '/rooms/:room/agents/:tag/prompt',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      requireRoomMember(req, room.id);
      const tag = assertTag(req.params.tag);
      const trigger = req.query.trigger ? Number(req.query.trigger) : null;
      const result = promptForAgent(room.id, tag, trigger);
      return { ...result, tag, roomId: room.id };
    }),
  );

  api.post(
    '/rooms/:room/agents/:tag/speak',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      requireRoomMember(req, room.id);
      const tag = assertTag(req.params.tag);
      speakNow(room.id, tag);
      return { ok: true, queued: tag };
    }),
  );

  api.post(
    '/rooms/:room/discuss',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      const me = requireRoomMember(req, room.id);
      const body = (req.body ?? {}) as { topic?: string; tags?: string[]; rounds?: number; text?: string };
      const topic = String(body.topic ?? body.text ?? '').trim();
      if (!topic) throw new HttpError(400, '缺少讨论主题');
      const tags = (Array.isArray(body.tags) ? body.tags : [])
        .map((t) => String(t).toLowerCase().replace(/^@/, ''))
        .filter(Boolean);
      const rounds = Number(body.rounds ?? 2);
      const promise = startDiscussion({ roomId: room.id, topic, tags, rounds, initiator: me });
      promise.catch((err) => console.error('[discuss] 失败', err));
      return { ok: true, topic, tags, rounds };
    }),
  );

  api.post(
    '/rooms/:room/control',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      requireRoomMember(req, room.id);
      const action = String((req.body as { action?: string })?.action ?? '');
      if (action === 'pause') pauseRoom(room.id);
      else if (action === 'resume') resumeRoom(room.id);
      else if (action === 'stop') return { ok: true, dropped: stopRoom(room.id) };
      else throw new HttpError(400, 'action 只能是 pause / resume / stop');
      return { ok: true, paused: isPaused(room.id) };
    }),
  );

  api.get(
    '/agents/:tag/runs',
    wrap((req) => {
      const me = requireAuth(req);
      const tag = assertTag(req.params.tag);
      if (!canViewRuns(me, tag)) throw new HttpError(403, '只能查看自己或同房间 AI 成员的运行记录');
      return { runs: listRuns(tag, Number(req.query.limit ?? 20)).map((r) => ({ ...publicRun(r), prompt: r.prompt })) };
    }),
  );

  /** 边缘运行器（ah agent run）上报一次本地 CLI 执行记录 */
  api.post(
    '/agents/:tag/runs',
    wrap(async (req) => {
      const me = requireAuth(req);
      const tag = assertTag(req.params.tag);
      if (tag !== me.tag && me.role !== 'admin') throw new HttpError(403, '只能上报自己的运行记录');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const db = getDb();
      const id = newId('run');
      db.prepare(
        `INSERT INTO agent_runs
          (id, room_id, agent_tag, trigger_msg, chain_id, hop, status, adapter_id, exit_code,
           duration_ms, error, prompt, output, created_at, finished_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        typeof body.roomId === 'string' ? body.roomId : null,
        tag,
        Number.isFinite(Number(body.triggerMsgId)) ? Number(body.triggerMsgId) : null,
        typeof body.chainId === 'string' ? body.chainId : null,
        Number.isFinite(Number(body.hop)) ? Number(body.hop) : 0,
        typeof body.status === 'string' ? body.status : 'ok',
        typeof body.adapterId === 'string' ? body.adapterId : null,
        Number.isFinite(Number(body.exitCode)) ? Number(body.exitCode) : null,
        Number.isFinite(Number(body.durationMs)) ? Number(body.durationMs) : null,
        typeof body.error === 'string' ? body.error : null,
        typeof body.prompt === 'string' ? body.prompt : '',
        typeof body.output === 'string' ? body.output.slice(-20_000) : '',
        now(),
        now(),
      );
      return { ok: true, id };
    }),
  );

  api.get(
    '/agents/:tag/runs/:id',
    wrap((req) => {
      const me = requireAuth(req);
      const tag = assertTag(req.params.tag);
      if (!canViewRuns(me, tag)) throw new HttpError(403, '只能查看自己或同房间 AI 成员的运行记录');
      const run = getRun(req.params.id);
      if (!run || run.agent_tag !== tag) throw new HttpError(404, '运行记录不存在');
      return { run: { ...publicRun(run), prompt: run.prompt, output: run.output } };
    }),
  );

  /* ------------------------------- 文件 ------------------------------- */

  api.get(
    '/rooms/:room/files',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      requireRoomMember(req, room.id);
      return { files: listRoomFiles(room.id, originOf(req)) };
    }),
  );

  api.post(
    '/rooms/:room/files',
    wrap(async (req) => {
      const room = resolveRoom(req.params.room);
      const me = requireRoomMember(req, room.id);
      const row = await handleUpload(req, room.id, me.tag);
      const origin = originOf(req);
      const file = publicFile(row, origin);
      const posted = postMessage({
        roomId: room.id,
        sender: me,
        text: `📎 上传了文件 ${row.name}（${formatSize(row.size)}）`,
        type: 'file',
        files: [row.id],
        meta: { noRoute: false },
      });
      const queued = routeMessage(posted);
      return { file, message: publicMessage(posted), queued };
    }),
  );

  api.delete(
    '/files/:id',
    wrap((req) => {
      const me = requireAuth(req);
      const row = getFile(req.params.id);
      if (!row) throw new HttpError(404, '文件不存在');
      if (row.uploader_tag !== me.tag && me.role !== 'admin') throw new HttpError(403, '只能删除自己上传的文件');
      const removed = removeFile(row.id);
      return { ok: true, removed: removed.id };
    }),
  );

  /** 下载 / 预览：支持 ?download=1 强制下载，也支持 ?token= 便于浏览器直接打开 */
  api.get(
    '/files/:id',
    wrap((req, res) => {
      const me = requireAuth(req);
      const row = getFile(req.params.id);
      if (!row) throw new HttpError(404, '文件不存在');
      if (!isRoomMember(row.room_id, me.tag) && me.role !== 'admin') {
        throw new HttpError(403, '你不是该文件所在房间的成员');
      }
      handleDownload(req, res, row.id);
    }),
  );

  /* ------------------------- 长轮询 / 状态 / 健康 ------------------------- */

  api.get(
    '/events',
    wrap(async (req) => {
      const me = requireAuth(req);
      const roomParam = String(req.query.room ?? req.query.roomId ?? '');
      if (!roomParam) throw new HttpError(400, '缺少 room 参数');
      const room = resolveRoom(roomParam);
      requireRoomMember(req, room.id);
      const after = Number(req.query.after ?? 0);
      const timeoutMs = Math.min(Math.max(Number(req.query.timeout ?? 25000), 0), 60000);
      const immediate = listMessages({ roomId: room.id, after, limit: Number(req.query.limit ?? 50) });
      if (immediate.length || timeoutMs === 0) {
        return { messages: immediate.map(publicMessage), lastId: immediate.at(-1)?.id ?? after };
      }
      const messages = await new Promise<unknown[]>((resolve) => {
        const subId = subscribe(
          (event) => {
            if (event.type !== 'message' || event.roomId !== room.id) return;
            const data = event.data as { id?: number };
            if (!data?.id || data.id <= after) return;
            cleanup();
            resolve(listMessages({ roomId: room.id, after, limit: 50 }).map(publicMessage));
          },
          { tag: me.tag, rooms: [room.id] },
        );
        const timer = setTimeout(() => {
          cleanup();
          resolve([]);
        }, timeoutMs);
        function cleanup(): void {
          clearTimeout(timer);
          unsubscribe(subId);
        }
      });
      return { messages, lastId: after };
    }),
  );

  api.get('/status', wrap(() => ({ runtime: runtimeSnapshot(), orchestrator: orchestratorStatus() })));

  api.get(
    '/health',
    wrap(async () => {
      const probes = await probeAll();
      return {
        ok: true,
        version: '0.1.0',
        time: now(),
        platform: process.platform,
        node: process.version,
        dataDir: path.join(REPO_ROOT, 'data'),
        adapters: probes,
        lanUrls: lanAddresses().map((l) => `http://${l.address}:${PORT}`),
      };
    }),
  );

  return api;
}

function roomMetaOf(room: RoomRow): Record<string, unknown> {
  return { ...DEFAULT_ROOM_META, ...parseJson<Record<string, unknown>>(room.meta, {}) };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function publicRun(row: {
  id: string;
  room_id: string | null;
  agent_tag: string;
  status: string;
  adapter_id: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
  chain_id: string | null;
  hop: number;
  trigger_msg: number | null;
}): Record<string, unknown> {
  return {
    id: row.id,
    roomId: row.room_id,
    agentTag: row.agent_tag,
    status: row.status,
    adapterId: row.adapter_id,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    error: row.error,
    chainId: row.chain_id,
    hop: row.hop,
    triggerMsg: row.trigger_msg,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

interface ParsedCommand {
  name: string;
  arg: string;
}

function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  return { name: name.toLowerCase(), arg: rest.join(' ') };
}

async function runCommand(
  req: Request,
  roomId: string,
  command: ParsedCommand,
  me: MemberRow,
): Promise<Record<string, unknown>> {
  const room = findRoom(roomId)!;
  switch (command.name) {
    case 'pause':
      pauseRoom(roomId);
      return { control: 'pause' };
    case 'resume':
      resumeRoom(roomId);
      return { control: 'resume' };
    case 'stop':
      return { control: 'stop', dropped: stopRoom(roomId) };
    case 'who': {
      const tags = listRoomMemberTags(roomId);
      const lines = tags
        .map((tag) => findMember(tag))
        .filter((m): m is MemberRow => Boolean(m))
        .map((m) => `@${m.tag}（${m.nickname}${m.kind === 'agent' ? ` · AI · ${m.agent_kind ?? ''}` : ''}）`);
      systemMessage(roomId, `房间成员：\n${lines.join('\n')}`);
      return { control: 'who' };
    }
    case 'discuss': {
      const roundsMatch = command.arg.match(/--rounds[= ](\d+)/);
      const rounds = roundsMatch ? Number(roundsMatch[1]) : 2;
      const topic = command.arg.replace(/--rounds[= ]\d+/, '').replace(/@[a-z0-9_-]+/gi, '').trim();
      const tags = parseMentions(command.arg, roomMemberTagSet(roomId)).filter(
        (tag) => findMember(tag)?.kind === 'agent',
      );
      const participants = tags.length
        ? tags
        : listRoomMemberTags(roomId).filter((tag) => findMember(tag)?.kind === 'agent');
      if (!topic) throw new HttpError(400, '用法：/discuss 主题 @ai --rounds 2');
      startDiscussion({ roomId, topic, tags: participants, rounds, initiator: me }).catch((err) =>
        console.error('[discuss] 失败', err),
      );
      return { control: 'discuss', topic, tags: participants, rounds };
    }
    case 'speak': {
      const tags = parseMentions(command.arg, roomMemberTagSet(roomId));
      for (const tag of tags) speakNow(roomId, tag);
      return { control: 'speak', tags };
    }
    case 'help':
      systemMessage(
        roomId,
        [
          '可用命令：',
          '/pause 暂停 AI 自动接力',
          '/resume 恢复自动接力',
          '/stop 清空排队中的任务并暂停',
          '/discuss 主题 @ai1 @ai2 --rounds 2 发起多 AI 讨论',
          '/speak @ai1 让某个 AI 主动发言',
          '/who 查看房间成员',
        ].join('\n'),
      );
      return { control: 'help' };
    default:
      throw new HttpError(400, `未知命令 /${command.name}，发送 /help 查看可用命令`);
  }
}

/** 静态资源 + SPA 回退（存在 web/dist 时后端可直接提供前端） */
export function serveWeb(app: express.Express, webDist: string): void {
  if (!fs.existsSync(webDist)) return;
  app.use(express.static(webDist, { index: false }));
  app.get(/^\/(?!api\/|ws).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}
