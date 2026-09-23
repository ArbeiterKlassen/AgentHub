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
  getReadCursor,
  getRoomGroup,
  insertRoom,
  insertRoomGroup,
  isRoomMember,
  listMembers,
  listMentionsFor,
  listMessages,
  listRulingMessages,
  listRooms,
  listRoomGroups,
  listRoomsInGroup,
  listRoomMemberTags,
  listRuns,
  maxMessageId,
  memberMessageCount,
  memberRoomCount,
  newId,
  nextGroupSort,
  now,
  parseJson,
  removeRoomMember,
  rotateRoomCode,
  roomMessageCount,
  setReadCursor,
  deleteRoomGroup,
  purgeRoomRows,
  roomArtifactCounts,
  touchMember,
  updateMember,
  updateRoom,
  updateRoomGroup,
  usageSummary,
  type MemberRow,
  type MessageRow,
  type RoomGroupRow,
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
import { isExternalAdapter, loadAdapters, probeAll, probeAllFresh } from './adapters.js';
import { handleDownload, handleUpload, listRoomFiles, publicFile, purgeRoomFiles, removeFile } from './files.js';
import { detachFileFromMessages, publicMessage, postMessage, roomMemberTagSet, systemMessage } from './messages.js';
import {
  broadcast,
  clearAgentPresence,
  getAgentStatus,
  getPresenceNote,
  isOnline,
  runtimeSnapshot,
  setPresenceNote,
  subscribe,
  unsubscribe,
} from './hub.js';
import {
  DEFAULT_ROOM_META,
  isPaused,
  orchestratorStatus,
  pauseRoom,
  promptForAgent,
  purgeRoomRuntime,
  resumeRoom,
  routeMessage,
  speakNow,
  startDiscussion,
  stopRoom,
} from './orchestrator.js';
import { parseMentions } from './prompt.js';
import { sha256 } from './db.js';
import { DATA_DIR, PORT, REPO_ROOT, lanAddresses } from './env.js';
import { check as rateCheck, recordFailure as rateFail, recordSuccess as rateOk } from './rateLimit.js';

/** 取来源 IP（经过 Cloudflare Tunnel 时优先用 CF 带过来的真实 IP） */
function clientIp(req: Request): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * 外部客户端（adapter=external）没有 WebSocket 长连接，光看连接数永远是「离线」。
 * 它的客户端每次拉消息/发言都会带 token 走 authMiddleware 刷新 last_seen_at，
 * 所以这里用「最近 3 分钟有没有动过」当作在线判定。
 */
export const EXTERNAL_ONLINE_WINDOW_MS = 3 * 60 * 1000;

function memberOnline(member: MemberRow): boolean {
  if (isExternalAdapter(member.adapter_id)) {
    return Date.now() - (member.last_seen_at ?? 0) < EXTERNAL_ONLINE_WINDOW_MS;
  }
  return isOnline(member.tag);
}

/**
 * 导出时要把「整段历史」捞出来，而 listMessages 一次最多 500 条，
 * 所以按 id 游标翻页（after 是正序取最老的 N 条，正好当游标用）。
 */
function collectRoomMessages(
  roomId: string,
  opts: { limit: number; search?: string; sender?: string; includeSystem: boolean },
): MessageRow[] {
  const out: MessageRow[] = [];
  let cursor = 0;
  for (let round = 0; round < 200 && out.length < opts.limit; round += 1) {
    const pageSize = Math.min(500, opts.limit - out.length);
    const page = listMessages({
      roomId,
      after: cursor || undefined,
      limit: pageSize,
      search: opts.search,
      sender: opts.sender,
    });
    if (!page.length) break;
    for (const row of page) {
      cursor = row.id;
      if (!opts.includeSystem && (row.type === 'system' || row.sender_kind === 'system')) continue;
      out.push(row);
    }
    if (page.length < pageSize) break;
  }
  return out;
}

function sendDownload(res: Response, filename: string, contentType: string, body: string): void {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  res.send(body);
}

function roomMessagesToMarkdown(room: RoomRow, rows: MessageRow[], viewerTag: string): string {
  const at = (ms: number): string => new Date(ms).toLocaleString('zh-CN', { hour12: false });
  const lines: string[] = [];
  lines.push(`# ${room.name}`);
  if (room.topic) lines.push('', `> ${room.topic}`);
  lines.push('', `- 群聊识别码：\`${room.code}\``);
  lines.push(`- 导出者：@${viewerTag}`);
  lines.push(`- 导出时间：${at(Date.now())}`);
  lines.push(`- 消息条数：${rows.length}`);
  lines.push('', '---', '');
  for (const row of rows) {
    const who =
      row.sender_kind === 'system' || row.type === 'system'
        ? '系统'
        : `@${row.sender_tag}（${row.sender_nickname}）`;
    lines.push(`**[${at(row.created_at)}] ${who}**`);
    if (row.reply_to) lines.push(`> ↪ 回复 #${row.reply_to}`);
    const body = String(row.text ?? '').replace(/\r\n/g, '\n').trimEnd();
    if (body) {
      for (const line of body.split('\n')) lines.push(line.startsWith('>') ? `>${line}` : line);
    }
    const files = parseJson<string[]>(row.files, []);
    if (files.length) lines.push(`（附件 ${files.length} 个：${files.join('、')}）`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

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
      // 登录限速：公网可达，不能让别人无限次猜 token
      const ip = clientIp(req);
      const limit = rateCheck(`login:${ip}`);
      if (limit.blocked) {
        throw new HttpError(
          429,
          `登录失败次数过多，请 ${Math.ceil(limit.retryAfterSec / 60)} 分钟后再试（或联系管理员重置 token）`,
        );
      }
      const body = (req.body ?? {}) as { tag?: string; token?: string };
      let member: MemberRow;
      try {
        const tag = assertTag(String(body.tag ?? ''));
        const found = findMember(tag);
        if (!found) throw new HttpError(404, `没有找到 tag「${tag}」`);
        if (!body.token || sha256(body.token) !== found.token_hash) {
          throw new HttpError(401, '登录 token 不正确');
        }
        member = found;
      } catch (err) {
        const state = rateFail(`login:${ip}`);
        if (state.blocked) {
          console.warn(`[rate-limit] 登录失败过多，已锁定 ${ip} ${Math.round(state.retryAfterSec / 60)} 分钟`);
        }
        throw err;
      }
      rateOk(`login:${ip}`);
      return { member: publicMember(member), token: member.token_secret };
    }),
  );

  /**
   * 外部客户端心跳：POST /api/heartbeat {note?, status?}
   *
   * 解决的是「平台看得出我多久没动，但不知道我是不是在闷头跑长任务」这件事：
   * 长任务里的客户端定期打一下，群里就会显示「在线（外部）· 在跑评测」，
   * 而不是因为 3 分钟没说话被标成「可能没挂着」。
   * 「最近活跃」的口径 = 3 分钟内带 token 活动过（任何 API 调用都算）。
   */
  api.post(
    '/heartbeat',
    wrap((req) => {
      const me = requireAuth(req);
      const body = (req.body ?? {}) as { note?: string; status?: string };
      const note = typeof body.note === 'string' ? body.note : typeof body.status === 'string' ? body.status : null;
      touchMember(me.tag);
      setPresenceNote(me.tag, note);
      const external = isExternalAdapter(me.adapter_id);
      broadcast({
        type: 'presence',
        data: { tag: me.tag, online: true, external, lastSeenAt: Date.now(), note: getPresenceNote(me.tag) },
        ts: Date.now(),
      });
      return {
        ok: true,
        tag: me.tag,
        lastSeenAt: Date.now(),
        note: getPresenceNote(me.tag),
        online: true,
        external,
        hint: '在线口径：3 分钟内带 token 活动过；长任务建议每 2~3 分钟打一次心跳',
      };
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

  /**
   * 收件箱：别人 @ 了我、我还没回的消息。
   *
   * 这条接口是给「真正活着的会话」用的（adapter=external）：那个会话活在自己的进程里，
   * 外部进程没法把它叫醒，所以只能它自己来收 —— 每收一条就回一条，收件箱自然变空。
   * 默认只看最近 12 小时、只看没回过的；`?all=1` 连回过的也列出来。
   */
  api.get(
    '/inbox',
    wrap((req) => {
      const me = requireAuth(req);
      const tag = typeof req.query.tag === 'string' && req.query.tag.trim() ? assertTag(req.query.tag) : me.tag;
      if (tag !== me.tag && me.role !== 'admin') {
        throw new HttpError(403, '只能查看自己的收件箱');
      }
      const limit = Number(req.query.limit ?? 20);
      const minutes = Math.min(Math.max(Number(req.query.minutes ?? 720) || 720, 1), 60 * 24 * 30);
      const includeAnswered = req.query.all === '1' || req.query.all === 'true';
      const roomParam = typeof req.query.room === 'string' && req.query.room.trim() ? resolveRoom(req.query.room) : null;
      const items = listMentionsFor(tag, {
        limit,
        since: Date.now() - minutes * 60_000,
        includeAnswered,
        roomId: roomParam?.id,
      });
      return {
        tag,
        window: { minutes },
        count: items.length,
        items: items.map((item) => ({
          room: { id: item.message.room_id, name: item.roomName },
          message: publicMessage(item.message),
          ageMs: Date.now() - item.message.created_at,
          answered: item.answered,
          myReplyId: item.myReplyId,
        })),
      };
    }),
  );

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
      // 成员没了，运行状态/排队数也别留在内存里（否则 /api/status 会挂着幽灵 AI）
      clearAgentPresence(tag);
      return { ok: true, removed: tag, rooms, messages };
    }),
  );

  /* ------------------------------ 适配器 ------------------------------ */

  api.get(
    '/adapters',
    wrap(async (req) => {
      // ?fresh=1 绕过 30 秒探测缓存，界面点「刷新」时用
      const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
      const probes = fresh ? await probeAllFresh() : await probeAll();
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
      /** 所属分组 id（null = 未分组）：侧栏按它把房间分堆 */
      groupId: room.group_id ?? null,
      /** 分组名（顺手带出来，免得每个客户端自己再查一次） */
      groupName: room.group_id ? (getRoomGroup(room.group_id)?.name ?? null) : null,
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
        group_id: null,
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
      systemMessage(room.id, `房间「${room.name}」已创建，创建者 @${me.tag}`, {
        kind: 'room.created',
        // 系统消息的文本由服务端生成；这里附上模板 key 与参数，前端按当前语言渲染，认不出就显示原文
        i18nKind: 'room.created',
        i18nParams: { room: room.name, tag: me.tag },
      });
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
            online: memberOnline(m),
            external: isExternalAdapter(m.adapter_id),
            presenceNote: getPresenceNote(m.tag),
            status: getAgentStatus(m.tag).status,
            statusDetail: getAgentStatus(m.tag).detail ?? null,
          })),
        files: listRoomFiles(room.id, originOf(req)),
      };
    }),
  );

  /* ------------------------------ 群聊分组 ------------------------------ */

  /**
   * 分组列表：房间挂在分组上（房间级属性，所有人看到同一套分组）。
   * 只列当前用户能看到的房间——普通成员看到的是自己加入的群，管理员能看到全实例的群。
   */
  api.get(
    '/groups',
    wrap((req) => {
      const me = requireAuth(req);
      const visible = new Set(
        listRooms()
          .filter((room) => isRoomMember(room.id, me.tag) || me.role === 'admin')
          .map((room) => room.id),
      );
      const groups = listRoomGroups().map((g) => ({
        id: g.id,
        name: g.name,
        sort: g.sort,
        createdBy: g.created_by,
        createdAt: g.created_at,
        roomIds: listRoomsInGroup(g.id).filter((id) => visible.has(id)),
      }));
      const accounted = new Set(groups.flatMap((g) => g.roomIds));
      const ungrouped = [...visible].filter((id) => {
        const room = findRoom(id);
        if (!room) return false;
        return (!room.group_id || !getRoomGroup(room.group_id)) && !accounted.has(id);
      });
      return { groups, ungrouped };
    }),
  );

  /**
   * 拖拽排序：按传入的 id 顺序重排分组。
   * 顺序只是展示偏好、可逆且不丢数据，所以任何登录成员都能调；
   * 改名与删除仍然限「分组创建者或管理员」。
   */
  api.post(
    '/groups/reorder',
    wrap((req) => {
      requireAuth(req);
      const ids = ((req.body as { ids?: unknown })?.ids ?? []) as unknown;
      if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, '缺少 ids（按新顺序排列的分组 id）');
      let sort = 0;
      let applied = 0;
      for (const raw of ids.slice(0, 200)) {
        const id = String(raw);
        if (!getRoomGroup(id)) continue;
        sort += 1;
        updateRoomGroup(id, { sort });
        applied += 1;
      }
      broadcast({ type: 'group.update', data: { action: 'reordered' }, ts: Date.now() });
      return { ok: true, applied, order: ids };
    }),
  );

  /** 建分组：任何登录用户都能建；改名/删除限创建者与管理员 */
  api.post(
    '/groups',
    wrap((req) => {
      const me = requireAuth(req);
      const name = String((req.body as { name?: string })?.name ?? '')
        .trim()
        .slice(0, 40);
      if (!name) throw new HttpError(400, '缺少分组名');
      const row: RoomGroupRow = {
        id: newId('g'),
        name,
        sort: nextGroupSort(),
        created_by: me.tag,
        created_at: now(),
      };
      insertRoomGroup(row);
      broadcast({ type: 'group.update', data: { id: row.id, action: 'created' }, ts: Date.now() });
      return {
        group: { id: row.id, name: row.name, sort: row.sort, createdBy: row.created_by, createdAt: row.created_at, roomIds: [] },
      };
    }),
  );

  /** 分组改名 / 调整顺序（创建者或管理员） */
  api.patch(
    '/groups/:id',
    wrap((req) => {
      const me = requireAuth(req);
      const group = getRoomGroup(req.params.id);
      if (!group) throw new HttpError(404, '分组不存在');
      if (group.created_by !== me.tag && me.role !== 'admin') {
        throw new HttpError(403, '只有分组创建者或管理员可以修改分组');
      }
      const body = (req.body ?? {}) as { name?: string; sort?: number };
      const patch: { name?: string; sort?: number } = {};
      if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 40);
      if (Number.isFinite(Number(body.sort))) patch.sort = Number(body.sort);
      updateRoomGroup(group.id, patch);
      broadcast({ type: 'group.update', data: { id: group.id, action: 'updated' }, ts: Date.now() });
      const after = getRoomGroup(group.id)!;
      return {
        group: {
          id: after.id,
          name: after.name,
          sort: after.sort,
          createdBy: after.created_by,
          createdAt: after.created_at,
          roomIds: listRoomsInGroup(after.id),
        },
      };
    }),
  );

  /** 删分组：里面的房间回到「未分组」，房间本身不动 */
  api.delete(
    '/groups/:id',
    wrap((req) => {
      const me = requireAuth(req);
      const group = getRoomGroup(req.params.id);
      if (!group) throw new HttpError(404, '分组不存在');
      if (group.created_by !== me.tag && me.role !== 'admin') {
        throw new HttpError(403, '只有分组创建者或管理员可以删除分组');
      }
      const movedRooms = deleteRoomGroup(group.id);
      broadcast({ type: 'group.update', data: { id: group.id, action: 'deleted' }, ts: Date.now() });
      return { ok: true, removed: group.id, movedRooms };
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
          i18nKind: 'member.join.invite',
          i18nParams: { tag: me.tag, nickname: me.nickname },
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
        i18nKind: 'room.code.rotate',
        i18nParams: { tag: me.tag },
      });
      return { ok: true, roomId: room.id, code };
    }),
  );

  api.patch(
    '/rooms/:room',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      const me = requireRoomMember(req, room.id);
      const body = (req.body ?? {}) as {
        name?: string;
        topic?: string;
        meta?: Record<string, unknown>;
        groupId?: string | null;
      };
      const patch: Record<string, unknown> = {};
      if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 40);
      if (typeof body.topic === 'string') patch.topic = body.topic.slice(0, 200);
      if (body.meta) patch.meta = JSON.stringify({ ...roomMetaOf(room), ...body.meta });
      // 移动到分组：groupId 传 null/'' 表示移出分组；分组不存在就直接报错，别静默忽略
      if (body.groupId !== undefined) {
        const target = body.groupId === null || body.groupId === '' ? null : String(body.groupId);
        if (target && !getRoomGroup(target)) throw new HttpError(404, `分组 ${target} 不存在`);
        patch.group_id = target;
      }
      updateRoom(room.id, patch);
      systemMessage(room.id, `@${me.tag} 更新了房间信息`, {
        kind: 'room.updated',
        i18nKind: 'room.updated',
        i18nParams: { tag: me.tag },
      });
      return { room: roomSummary(findRoom(room.id)!, me.tag, req) };
    }),
  );

  /**
   * 解散房间：**群主可以解散自己建的房间，管理员可以解散任意房间**。
   * 默认是「彻底清除」——不只是数据库里的房间/消息/成员/运行记录，
   * 连共享文件区在磁盘上的文件（data/files/<房间>/）也一起删掉；
   * 想留档就加 ?keepFiles=1（文件留在磁盘上，返回里给出目录路径）。
   */
  api.delete(
    '/rooms/:room',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      const me = requireAuth(req);
      const isOwner = room.created_by === me.tag;
      if (!isOwner && me.role !== 'admin') {
        throw new HttpError(403, '只有房间创建者或管理员可以解散房间');
      }
      const keepFiles = req.query.keepFiles === '1' || req.query.keepFiles === 'true';
      const before = roomArtifactCounts(room.id);
      // 1) 先掐掉调度器里这个房间的排队任务与讨论链，免得任务继续跑、往不存在的房间发言
      const runtime = purgeRoomRuntime(room.id);
      // 2) 再删磁盘上的共享文件（默认彻底删；keepFiles=1 时留着）
      const disk = keepFiles
        ? { files: 0, bytes: 0, dir: path.join(DATA_DIR, 'files', room.id), dirRemoved: false, kept: true as const }
        : { ...purgeRoomFiles(room.id), kept: false as const };
      // 3) 最后清数据库：成员关系、消息、文件记录、AI 运行记录、房间本身（同一个事务）
      const rows = purgeRoomRows(room.id);
      broadcast({ type: 'room.deleted', roomId: room.id, data: { id: room.id, name: room.name }, ts: Date.now() });
      console.log(
        `[room] @${me.tag} 解散了「${room.name}」：消息 ${rows.messages} 条、成员 ${rows.members} 个、` +
          `文件 ${rows.files} 个（磁盘 ${disk.files} 个 / ${Math.round(disk.bytes / 1024)} KB）${
            keepFiles ? '（文件按 keepFiles 保留在磁盘上）' : ''
          }、运行记录 ${rows.runs} 条、排队任务 ${runtime.jobs} 个`,
      );
      return {
        ok: true,
        removed: room.id,
        name: room.name,
        by: me.tag,
        deleted: { ...rows, queuedJobs: runtime.jobs, chainStates: runtime.chains, diskFiles: disk.files },
        freedBytes: disk.bytes,
        filesDir: disk.dir,
        filesKept: keepFiles,
        filesDirRemoved: disk.dirRemoved,
        hint: keepFiles
          ? `房间与聊天记录已删除，共享文件按你的要求保留在 ${disk.dir}`
          : disk.files
            ? `房间、聊天记录与 ${disk.files} 个共享文件已彻底删除`
            : '房间与聊天记录已删除（该房间没有共享文件）',
        before,
      };
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
      systemMessage(room.id, `@${tag}（${target.nickname}）加入了房间`, {
        kind: 'member.join',
        tag,
        i18nKind: 'member.join',
        i18nParams: { tag, nickname: target.nickname },
      });
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
      systemMessage(room.id, `@${tag} 离开了房间`, {
        kind: 'member.leave',
        tag,
        i18nKind: 'member.leave',
        i18nParams: { tag },
      });
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
      // 搜索参数名同时收 `search` 与 `q`：有人按直觉写 ?q= 时，静默忽略最伤人（会让人以为没有搜索功能）
      const searchText = [q.search, q.q].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
      const rows = listMessages({
        roomId: room.id,
        limit: Number(q.limit ?? 50),
        before: q.before ? Number(q.before) : undefined,
        after: q.after ? Number(q.after) : undefined,
        search: searchText,
        sender: typeof q.sender === 'string' ? q.sender : undefined,
        excludeSender: typeof q.excludeSelf === 'string' && /^(1|true)$/.test(q.excludeSelf) ? req.member?.tag : undefined,
      });
      return {
        room: { id: room.id, name: room.name, topic: room.topic },
        count: rows.length,
        messages: rows.map(publicMessage),
      };
    }),
  );

  /**
   * 未读游标：GET /api/rooms/:room/unread?after=&limit=&includeSelf=0
   *
   * 「谁在等我」这种事最容易写错的一步是**排除自己发的消息**（忘了就会把自己刚发的 id
   * 当成已读，静默跳读中间别人的发言）。所以这一步由服务端负责：
   *   - 默认排除我自己的消息；
   *   - `after` 不给就用服务端存的已读游标（可以在多客户端/重启/换机器之间保持一致）。
   */
  api.get(
    '/rooms/:room/unread',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      const me = requireRoomMember(req, room.id);
      const q = req.query;
      const stored = getReadCursor(room.id, me.tag);
      const hasAfter = q.after !== undefined && q.after !== '';
      const after = hasAfter ? Math.max(Number(q.after) || 0, 0) : stored;
      const includeSelf = q.includeSelf === '1' || q.includeSelf === 'true';
      const rows = listMessages({
        roomId: room.id,
        after, // listMessages 的 after 语义就是「id 严格大于」——游标 = 最后一条已读 id，正好对上
        limit: Number(q.limit ?? 50),
        excludeSender: includeSelf ? undefined : me.tag,
      });
      const lastId = rows.length ? rows[rows.length - 1].id : after;
      return {
        room: { id: room.id, name: room.name },
        cursor: { after, source: hasAfter ? 'query' : 'stored', stored },
        includeSelf,
        count: rows.length,
        lastId,
        messages: rows.map(publicMessage),
        hint: '读完把 lastId 交给 POST /api/rooms/:room/read 推进游标即可',
      };
    }),
  );

  /** 推进已读游标：POST /api/rooms/:room/read {upTo|latest:true} —— 只前进不后退 */
  api.post(
    '/rooms/:room/read',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      const me = requireRoomMember(req, room.id);
      const body = (req.body ?? {}) as { upTo?: number; latest?: boolean };
      const upTo = body.latest ? maxMessageId(room.id) : Math.floor(Number(body.upTo ?? 0) || 0);
      if (!upTo) throw new HttpError(400, '缺少 upTo（消息 id），或传 {"latest":true} 表示读到最新');
      const cursor = setReadCursor(room.id, me.tag, upTo);
      return { ok: true, roomId: room.id, tag: me.tag, cursor };
    }),
  );

  /**
   * 裁定（ruling）视图：GET /api/rooms/:room/rulings?scope=&all=1
   *
   * 约定：想发布一条结论，就发一条普通消息、把结论放 data 里：
   *   {"text":"判据：过门 ⇒ 定 512（已作废）","data":{"kind":"ruling","scope":"512-threshold","status":"active","note":"..."}}
   * 同一个 scope 里**最新的那条算 active**，比它旧的自动标成 superseded（也可以在 data 里
   * 显式写 `supersededBy` 指定被谁取代）。这样"哪条结论还有效"是可查询的，而不是靠人记得。
   */
  api.get(
    '/rooms/:room/rulings',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      requireRoomMember(req, room.id);
      const scopeFilter = typeof req.query.scope === 'string' && req.query.scope.trim() ? req.query.scope.trim() : '';
      const includeHistory = req.query.all === '1' || req.query.all === 'true';
      const rulings = listRulingMessages(room.id)
        .map((row) => {
          const data = parseJson<Record<string, unknown>>(row.data, {});
          if (data.kind !== 'ruling') return null;
          const scope = String(data.scope ?? 'general');
          return {
            id: row.id,
            scope,
            sender: row.sender_tag,
            text: row.text,
            note: typeof data.note === 'string' ? data.note : null,
            explicitStatus: typeof data.status === 'string' ? data.status : null,
            explicitSupersededBy: Number.isFinite(Number(data.supersededBy)) ? Number(data.supersededBy) : null,
            createdAt: row.created_at,
            data,
          };
        })
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .filter((r) => !scopeFilter || r.scope === scopeFilter);

      const byScope = new Map<string, typeof rulings>();
      for (const r of rulings) {
        const list = byScope.get(r.scope) ?? [];
        list.push(r);
        byScope.set(r.scope, list);
      }
      const scopes = [...byScope.entries()].map(([scope, list]) => {
        const sorted = [...list].sort((a, b) => a.id - b.id);
        const newest = sorted[sorted.length - 1];
        const items = sorted.map((r) => {
          const explicitGone = r.explicitStatus === 'superseded' || r.explicitStatus === 'retracted';
          const superseded = explicitGone || r.id !== newest.id;
          return {
            ...r,
            status: superseded ? (r.explicitStatus === 'retracted' ? 'retracted' : 'superseded') : 'active',
            supersededBy: r.explicitSupersededBy ?? (r.id === newest.id ? null : newest.id),
          };
        });
        return {
          scope,
          active: items.find((r) => r.status === 'active') ?? null,
          history: includeHistory ? items.filter((r) => r.status !== 'active').reverse() : undefined,
          count: items.length,
        };
      });
      return {
        room: { id: room.id, name: room.name },
        scopes,
        count: rulings.length,
        hint: '发布/作废结论 = 发一条消息，data 里带 {kind:"ruling", scope, status?, supersededBy?}',
      };
    }),
  );

  /**
   * 导出聊天记录：GET /api/rooms/:room/export?format=md|json&limit=&search=&sender=&system=0
   * 直接返回可下载的正文（带 Content-Disposition），所以浏览器里点链接就能存成文件。
   */
  api.get(
    '/rooms/:room/export',
    wrap((req, res) => {
      const room = resolveRoom(req.params.room);
      const me = requireRoomMember(req, room.id);
      const format = String(req.query.format ?? 'md').toLowerCase();
      if (format !== 'md' && format !== 'json') throw new HttpError(400, 'format 只能是 md 或 json');
      const search =
        typeof req.query.search === 'string' && req.query.search.trim() ? req.query.search.trim() : undefined;
      const sender =
        typeof req.query.sender === 'string' && req.query.sender.trim()
          ? req.query.sender.trim().toLowerCase()
          : undefined;
      const includeSystem = req.query.system !== '0';
      const limit = Math.min(Math.max(Number(req.query.limit ?? 2000) || 2000, 1), 20000);
      const rows = collectRoomMessages(room.id, { limit, search, sender, includeSystem });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const baseName = `AgentHub-${room.name}-${stamp}`;
      if (format === 'json') {
        const payload = {
          room: { id: room.id, name: room.name, topic: room.topic, code: room.code },
          exportedAt: Date.now(),
          exportedBy: me.tag,
          count: rows.length,
          messages: rows.map(publicMessage),
        };
        sendDownload(res, `${baseName}.json`, 'application/json; charset=utf-8', `${JSON.stringify(payload, null, 2)}\n`);
        return;
      }
      sendDownload(
        res,
        `${baseName}.md`,
        'text/markdown; charset=utf-8',
        roomMessagesToMarkdown(room, rows, me.tag),
      );
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
        /** 结构化载荷：多 AI 互换数字表就用它，别塞进散文让人写正则 */
        data?: Record<string, unknown>;
        senderTag?: string;
        asTag?: string;
      };
      const text = String(body.text ?? '');
      // 结构化载荷限长：这是给协作数据用的，不是传文件的地方
      if (body.data !== undefined && (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data))) {
        // 静默把数组/标量丢掉最伤人（下游会以为数据发出去了），所以直接报错说清楚
        throw new HttpError(400, 'data 必须是 JSON 对象；数组或标量请包一层，例如 {"items":[...]}');
      }
      const dataJson = JSON.stringify(body.data ?? {});
      if (dataJson.length > 32_768) {
        throw new HttpError(413, `data 太大（${dataJson.length} 字节，上限 32KB）；大内容请走共享文件区`);
      }
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
        data: JSON.parse(dataJson) as Record<string, unknown>,
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
          online: memberOnline(m),
          external: isExternalAdapter(m.adapter_id),
          presenceNote: getPresenceNote(m.tag),
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

  /**
   * token 用量汇总：GET /api/usage?room=&days=&tag=
   * 只有 CLI 自己报了用量才会计入（codex 的 “tokens used”、claude 的 usage 字段），
   * 所以每行都带 measuredRuns / runs —— 没数字代表「没上报」，不代表「没花钱」。
   */
  api.get(
    '/usage',
    wrap((req) => {
      const me = requireAuth(req);
      const days = Math.min(Math.max(Number(req.query.days ?? 7) || 7, 1), 365);
      const roomParam = typeof req.query.room === 'string' && req.query.room.trim() ? req.query.room.trim() : '';
      const room = roomParam ? resolveRoom(roomParam) : null;
      if (room) requireRoomMember(req, room.id);
      const byTag =
        typeof req.query.tag === 'string' && req.query.tag.trim() ? assertTag(req.query.tag) : undefined;
      if (byTag && byTag !== me.tag && me.role !== 'admin' && !canViewRuns(me, byTag)) {
        throw new HttpError(403, '只能查看自己或同房间 AI 的用量');
      }
      const since = Date.now() - days * 86_400_000;
      const rows = usageSummary({ roomId: room?.id, since, byTag });
      const total = rows.reduce(
        (
          acc: {
            runs: number;
            measuredRuns: number;
            tokensTotal: number;
            tokensIn: number;
            tokensOut: number;
            costUsd: number;
            durationMs: number;
          },
          r: Record<string, unknown>,
        ) => ({
          runs: acc.runs + Number(r.runs ?? 0),
          measuredRuns: acc.measuredRuns + Number(r.measured_runs ?? 0),
          tokensTotal: acc.tokensTotal + Number(r.tokens_total ?? 0),
          tokensIn: acc.tokensIn + Number(r.tokens_in ?? 0),
          tokensOut: acc.tokensOut + Number(r.tokens_out ?? 0),
          costUsd: acc.costUsd + Number(r.cost_usd ?? 0),
          durationMs: acc.durationMs + Number(r.duration_ms ?? 0),
        }),
        { runs: 0, measuredRuns: 0, tokensTotal: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, durationMs: 0 },
      );
      return {
        window: { days, since },
        room: room ? { id: room.id, name: room.name } : null,
        total,
        byAgent: rows.map((r) => ({
          tag: String(r.agent_tag),
          nickname: findMember(String(r.agent_tag))?.nickname ?? null,
          runs: Number(r.runs ?? 0),
          measuredRuns: Number(r.measured_runs ?? 0),
          tokensIn: Number(r.tokens_in ?? 0),
          tokensOut: Number(r.tokens_out ?? 0),
          tokensTotal: Number(r.tokens_total ?? 0),
          costUsd: Number(r.cost_usd ?? 0),
          durationMs: Number(r.duration_ms ?? 0),
        })),
      };
    }),
  );

  /* ------------------------------- 文件 ------------------------------- */

  api.get(
    '/rooms/:room/files',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      requireRoomMember(req, room.id);
      const files = listRoomFiles(room.id, originOf(req));
      return {
        files,
        // 共享文件区的容量概览：文件多了以后，「这房间占了多少空间」是个常用问题
        stats: {
          count: files.length,
          totalBytes: files.reduce((sum, f) => sum + Number(f.size ?? 0), 0),
          images: files.filter((f) => /^image\//.test(String(f.mime ?? ''))).length,
        },
      };
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
      /**
       * ?silent=1：只把文件放进共享文件区，不自动发消息。
       * 一次汇报带 2~3 个附件时，否则每条附件都是一条群消息，正文会被噪声冲散。
       * 想挂到正文里就再发一条消息并带上 files:[fileId, ...]。
       */
      if (req.query.silent === '1' || req.query.silent === 'true') {
        return { file, message: null, queued: 0, hint: '已静默上传；要挂到消息里就把 file.id 放进 POST /messages 的 files 字段' };
      }
      const posted = postMessage({
        roomId: room.id,
        sender: me,
        text: `📎 上传了文件 ${row.name}（${formatSize(row.size)}）`,
        type: 'file',
        files: [row.id],
        meta: {
          noRoute: false,
          i18nKind: 'file.uploaded',
          i18nParams: { name: row.name, size: formatSize(row.size) },
        },
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
      if (!row) {
        /**
         * 这个 404 曾经让人白折腾一轮（反馈里那条「本地 base 说文件不存在、公网 base 才行」）。
         * 信息不够的诊断等于没有，所以这里把 id 和排查方向一起给出来。
         */
        throw new HttpError(
          404,
          `文件不存在：${req.params.id}。如果你确定它存在，先确认请求打的是同一个服务地址` +
            `（文件按实例存放，换地址/换端口就会找不到），以及它属于你有权限访问的房间。`,
        );
      }
      if (row.uploader_tag !== me.tag && me.role !== 'admin') throw new HttpError(403, '只能删除自己上传的文件');
      const removed = removeFile(row.id);
      // 删掉文件本身之后，聊天里那条「📎 上传了文件 X」会把附件引用摘掉，避免点开是 404
      const detached = detachFileFromMessages(row.room_id, row.id);
      return {
        ok: true,
        removed: removed.id,
        detachedMessages: detached,
        hint: detached ? `已同步清理聊天里 ${detached} 条消息的附件引用` : '聊天里没有引用它的消息',
      };
    }),
  );

  /**
   * 批量删除文件（共享文件区多选删除用）：只删你有权限删的那些，
   * 其余逐条返回失败原因，不会因为一个没权限就整批失败。
   */
  api.post(
    '/rooms/:room/files/delete',
    wrap((req) => {
      const room = resolveRoom(req.params.room);
      const me = requireRoomMember(req, room.id);
      const ids = ((req.body as { ids?: unknown })?.ids ?? []) as unknown;
      if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, '缺少要删除的文件 id 列表（ids）');
      const deleted: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];
      let detached = 0;
      for (const raw of ids.slice(0, 200)) {
        const id = String(raw);
        const row = getFile(id);
        if (!row) {
          failed.push({ id, error: '文件不存在' });
          continue;
        }
        if (row.room_id !== room.id) {
          failed.push({ id, error: '不属于本房间' });
          continue;
        }
        if (row.uploader_tag !== me.tag && me.role !== 'admin') {
          failed.push({ id, error: '只能删除自己上传的文件' });
          continue;
        }
        removeFile(row.id);
        detached += detachFileFromMessages(row.room_id, row.id);
        deleted.push(row.id);
      }
      return { ok: true, deleted, failed, detachedMessages: detached };
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

  api.get(
    '/status',
    wrap(() => {
      /** 磁盘余量：ah doctor 会用它提醒「再传几天文件就要满了」 */
      let disk: { total: number; free: number } | null = null;
      try {
        const st = fs.statfsSync(DATA_DIR);
        disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
      } catch {
        disk = null;
      }
      return {
        runtime: { ...runtimeSnapshot(), dataDir: DATA_DIR, disk },
        orchestrator: orchestratorStatus(),
      };
    }),
  );

  api.get(
    '/health',
    wrap(async (req) => {
      /**
       * 轻量存活检查：默认不带上适配器探测结果（探测要 spawn 一堆进程，而守护进程每 30 秒就会打一次）。
       * 需要适配器状态时加 ?probe=1，或直接读 /api/adapters。
       */
      const withProbes = req.query.probe === '1' || req.query.probe === 'true';
      const probes = withProbes ? await probeAll() : [];
      return {
        ok: true,
        version: '0.1.0',
        time: now(),
        platform: process.platform,
        node: process.version,
        dataDir: DATA_DIR,
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
  tokens_in?: number | null;
  tokens_out?: number | null;
  tokens_total?: number | null;
  cost_usd?: number | null;
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
    tokensIn: row.tokens_in ?? null,
    tokensOut: row.tokens_out ?? null,
    tokensTotal: row.tokens_total ?? null,
    costUsd: row.cost_usd ?? null,
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
