import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureDirs } from './env.js';
import { flushNow, record } from './flightRecorder.js';

export interface MemberRow {
  tag: string;
  nickname: string;
  kind: 'human' | 'agent';
  agent_kind: string | null;
  adapter_id: string | null;
  avatar: string;
  color: string;
  token_hash: string;
  token_secret: string;
  role: 'admin' | 'member';
  trigger_mode: 'mentions' | 'all' | 'manual';
  workdir: string | null;
  system_prompt: string | null;
  meta: string;
  created_at: number;
  last_seen_at: number | null;
}

export interface RoomRow {
  id: string;
  name: string;
  topic: string;
  created_by: string | null;
  meta: string;
  created_at: number;
  /** 群聊邀请码：给人看/复制/手输的短码（新建房间时生成，可重置） */
  code: string;
  /** 所属分组（room_groups.id）；null = 未分组 */
  group_id: string | null;
}

export interface RoomGroupRow {
  id: string;
  name: string;
  sort: number;
  created_by: string | null;
  created_at: number;
}

export interface MessageRow {
  id: number;
  room_id: string;
  sender_tag: string;
  sender_nickname: string;
  sender_kind: string;
  type: string;
  text: string;
  mentions: string;
  files: string;
  reply_to: number | null;
  chain_id: string | null
  ;
  hop: number;
  meta: string;
  /**
   * 结构化载荷（任意 JSON 对象，给人看的话仍写在 text 里）。
   * 存在的理由：多个 AI 互换数字表时，不该逼着双方写正则从散文里捞数——
   * 捞错不会报错，只会静默得出错误结论。meta 是平台自己用的保留字段，别混用。
   */
  data: string;
  created_at: number;
}

export interface FileRow {
  id: string;
  room_id: string;
  name: string;
  size: number;
  mime: string | null;
  uploader_tag: string;
  sha256: string;
  stored_path: string;
  /** 同名文件的第几版（同一房间内按 name 计数），配上 previous_id 就能看出"这份替换了哪份" */
  version: number;
  previous_id: string | null;
  created_at: number;
}

export interface RunRow {
  id: string;
  room_id: string | null;
  agent_tag: string;
  trigger_msg: number | null;
  chain_id: string | null;
  hop: number;
  status: string;
  adapter_id: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  error: string | null;
  prompt: string;
  output: string;
  created_at: number;
  finished_at: number | null;
  /** token 用量：CLI 报了就记，没报为 null */
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_total: number | null;
  cost_usd: number | null;
}

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  ensureDirs();
  db = openWithRetry();
  ensureRoomCodes();
  return db;
}

/** 同步等待（SQLite 打开重试用；不引入 async 传染） */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 打开数据库。
 *
 * 为什么不是直接 `new DatabaseSync()`：桌面图标可以点第二次、守护进程也可能刚拉过一个子进程，
 * 于是两个进程会同时开同一个库。第一个进程在建表（写事务）时，第二个进程拿到的是
 * `database is locked`（SQLITE_BUSY），历史上表现为「服务刚启动 1 秒就 code=1 退出」，
 * 然后守护进程无限重启。这里加 busy_timeout + 有限重试：等前一个进程建完表，再照常打开。
 */
function openWithRetry(): DatabaseSync {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const d = new DatabaseSync(DB_PATH);
      // busy_timeout 必须在第一次写之前生效：WAL + 5 秒等待，够另一个进程建完表
      d.exec('PRAGMA busy_timeout = 5000');
      d.exec('PRAGMA journal_mode = WAL');
      d.exec('PRAGMA foreign_keys = ON');
      migrate(d);
      return d;
    } catch (err) {
      const code = (err as { errcode?: number }).errcode;
      // 5 = SQLITE_BUSY，6 = SQLITE_LOCKED
      if ((code === 5 || code === 6) && Date.now() < deadline) {
        sleepSync(200);
        continue;
      }
      throw err;
    }
  }
}

function migrate(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS members (
      tag           TEXT PRIMARY KEY,
      nickname      TEXT NOT NULL,
      kind          TEXT NOT NULL DEFAULT 'human',
      agent_kind    TEXT,
      adapter_id    TEXT,
      avatar        TEXT NOT NULL DEFAULT '🙂',
      color         TEXT NOT NULL DEFAULT '#3b82f6',
      token_hash    TEXT NOT NULL,
      token_secret  TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'member',
      trigger_mode  TEXT NOT NULL DEFAULT 'mentions',
      workdir       TEXT,
      system_prompt TEXT,
      meta          TEXT NOT NULL DEFAULT '{}',
      created_at    INTEGER NOT NULL,
      last_seen_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      topic      TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      meta       TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      code       TEXT
    );

    /* 群聊分组（侧栏里的"文件夹"）：房间挂在分组上，所有人看到同一套分组 */
    CREATE TABLE IF NOT EXISTS room_groups (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      sort       INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_members (
      room_id   TEXT NOT NULL,
      tag       TEXT NOT NULL,
      role      TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL,
      -- 每人在每个房间的「读到哪了」：给未读游标用（外部客户端最容易写错的就是这一步）
      last_read_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, tag)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id         TEXT NOT NULL,
      sender_tag      TEXT NOT NULL,
      sender_nickname TEXT NOT NULL,
      sender_kind     TEXT NOT NULL,
      type            TEXT NOT NULL DEFAULT 'text',
      text            TEXT NOT NULL DEFAULT '',
      mentions        TEXT NOT NULL DEFAULT '[]',
      files           TEXT NOT NULL DEFAULT '[]',
      reply_to        INTEGER,
      chain_id        TEXT,
      hop             INTEGER NOT NULL DEFAULT 0,
      meta            TEXT NOT NULL DEFAULT '{}',
      data            TEXT NOT NULL DEFAULT '{}',
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages (room_id, id);

    CREATE TABLE IF NOT EXISTS files (
      id           TEXT PRIMARY KEY,
      room_id      TEXT NOT NULL,
      name         TEXT NOT NULL,
      size         INTEGER NOT NULL,
      mime         TEXT,
      uploader_tag TEXT NOT NULL,
      sha256       TEXT NOT NULL DEFAULT '',
      stored_path  TEXT NOT NULL,
      version      INTEGER NOT NULL DEFAULT 1,
      previous_id  TEXT,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_files_room ON files (room_id, created_at);

    CREATE TABLE IF NOT EXISTS agent_runs (
      id          TEXT PRIMARY KEY,
      room_id     TEXT,
      agent_tag   TEXT NOT NULL,
      trigger_msg INTEGER,
      chain_id    TEXT,
      hop         INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'running',
      adapter_id  TEXT,
      exit_code   INTEGER,
      duration_ms INTEGER,
      error       TEXT,
      prompt      TEXT NOT NULL DEFAULT '',
      output      TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      finished_at INTEGER,
      tokens_in   INTEGER,
      tokens_out  INTEGER,
      tokens_total INTEGER,
      cost_usd    REAL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_agent ON agent_runs (agent_tag, created_at);
  `);

  // 老库补 code 列（CREATE TABLE IF NOT EXISTS 不会给已存在的表加列）
  const cols = d.prepare('PRAGMA table_info(rooms)').all() as unknown as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'code')) {
    d.exec('ALTER TABLE rooms ADD COLUMN code TEXT');
  }
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_code ON rooms (code)');

  // 老库补用量列（③ token 统计：CLI 报了多少就记多少）
  const runCols = d.prepare('PRAGMA table_info(agent_runs)').all() as unknown as Array<{ name: string }>;
  for (const col of ['tokens_in', 'tokens_out', 'tokens_total'] as const) {
    if (!runCols.some((c) => c.name === col)) d.exec(`ALTER TABLE agent_runs ADD COLUMN ${col} INTEGER`);
  }
  if (!runCols.some((c) => c.name === 'cost_usd')) d.exec('ALTER TABLE agent_runs ADD COLUMN cost_usd REAL');

  // 老库补「已读游标」列
  const memberCols = d.prepare('PRAGMA table_info(room_members)').all() as unknown as Array<{ name: string }>;
  if (!memberCols.some((c) => c.name === 'last_read_id')) {
    d.exec('ALTER TABLE room_members ADD COLUMN last_read_id INTEGER NOT NULL DEFAULT 0');
  }

  // 老库补「结构化载荷」列（消息）与「同名版本」列（文件）
  const msgCols = d.prepare('PRAGMA table_info(messages)').all() as unknown as Array<{ name: string }>;
  if (!msgCols.some((c) => c.name === 'data')) {
    d.exec("ALTER TABLE messages ADD COLUMN data TEXT NOT NULL DEFAULT '{}'");
  }
  const fileCols = d.prepare('PRAGMA table_info(files)').all() as unknown as Array<{ name: string }>;
  if (!fileCols.some((c) => c.name === 'version')) {
    d.exec('ALTER TABLE files ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  }
  if (!fileCols.some((c) => c.name === 'previous_id')) {
    d.exec('ALTER TABLE files ADD COLUMN previous_id TEXT');
  }

  // 老库补房间分组列
  const roomCols = d.prepare('PRAGMA table_info(rooms)').all() as unknown as Array<{ name: string }>;
  if (!roomCols.some((c) => c.name === 'group_id')) {
    d.exec('ALTER TABLE rooms ADD COLUMN group_id TEXT');
  }
}

/** 邀请码字符集：去掉 0/O/1/I 这些看起来像的，方便手输 */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 6;

export function generateRoomCode(): string {
  const bytes = crypto.randomBytes(ROOM_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** 用户输入的邀请码归一化：大小写不敏感，忽略空格/短横线等 */
export function normalizeRoomCode(raw: string): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, 32);
}

/** 给还没邀请码的房间补一个（幂等，启动时调用） */
export function ensureRoomCodes(): number {
  const d = getDb();
  const rows = d
    .prepare("SELECT id FROM rooms WHERE code IS NULL OR code = ''")
    .all() as unknown as Array<{ id: string }>;
  let filled = 0;
  for (const row of rows) {
    let code = generateRoomCode();
    while (d.prepare('SELECT 1 AS ok FROM rooms WHERE code = ?').get(code)) {
      code = generateRoomCode();
    }
    d.prepare('UPDATE rooms SET code = ? WHERE id = ?').run(code, row.id);
    filled += 1;
  }
  return filled;
}

export const now = (): number => Date.now();

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const newId = (prefix: string): string =>
  `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

export const sha256 = (value: string | Buffer): string =>
  crypto.createHash('sha256').update(value).digest('hex');

/* ------------------------------- members ------------------------------- */

export function insertMember(row: MemberRow): void {
  getDb()
    .prepare(
      `INSERT INTO members
        (tag, nickname, kind, agent_kind, adapter_id, avatar, color, token_hash, token_secret,
         role, trigger_mode, workdir, system_prompt, meta, created_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.tag,
      row.nickname,
      row.kind,
      row.agent_kind,
      row.adapter_id,
      row.avatar,
      row.color,
      row.token_hash,
      row.token_secret,
      row.role,
      row.trigger_mode,
      row.workdir,
      row.system_prompt,
      row.meta,
      row.created_at,
      row.last_seen_at,
    );
}

export function findMember(tag: string): MemberRow | undefined {
  return getDb().prepare('SELECT * FROM members WHERE tag = ?').get(tag) as
    | MemberRow
    | undefined;
}

export function findMemberByToken(token: string): MemberRow | undefined {
  return getDb()
    .prepare('SELECT * FROM members WHERE token_hash = ?')
    .get(sha256(token)) as MemberRow | undefined;
}

export function listMembers(): MemberRow[] {
  return getDb()
    .prepare('SELECT * FROM members ORDER BY kind DESC, created_at ASC')
    .all() as unknown as MemberRow[];
}

export function countMembers(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number };
  return row.n;
}

export function updateMember(tag: string, patch: Record<string, unknown>): void {
  const allowed = [
    'nickname',
    'avatar',
    'color',
    'trigger_mode',
    'workdir',
    'system_prompt',
    'adapter_id',
    'agent_kind',
    'role',
    'meta',
    'last_seen_at',
  ];
  const keys = Object.keys(patch).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  const sql = `UPDATE members SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE tag = ?`;
  getDb()
    .prepare(sql)
    .run(...keys.map((k) => patch[k] as string | number | null), tag);
}

export function touchMember(tag: string): void {
  getDb().prepare('UPDATE members SET last_seen_at = ? WHERE tag = ?').run(now(), tag);
}

/** 该成员还在几个房间里 */
export function memberRoomCount(tag: string): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM room_members WHERE tag = ?').get(tag) as { n: number };
  return row.n;
}

/** 该成员在群里说过多少条 */
export function memberMessageCount(tag: string): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_tag = ?').get(tag) as { n: number };
  return row.n;
}

/** 删除成员：连带清掉它的房间成员关系与运行记录（消息保留，避免破坏历史记录） */
export function deleteMember(tag: string): void {
  const d = getDb();
  d.prepare('DELETE FROM room_members WHERE tag = ?').run(tag);
  d.prepare('DELETE FROM agent_runs WHERE agent_tag = ?').run(tag);
  d.prepare('DELETE FROM members WHERE tag = ?').run(tag);
}

/* -------------------------------- rooms -------------------------------- */

export function insertRoom(row: RoomRow): void {
  getDb()
    .prepare(
      `INSERT INTO rooms (id, name, topic, created_by, meta, created_at, code) VALUES (?,?,?,?,?,?,?)`,
    )
    .run(row.id, row.name, row.topic, row.created_by, row.meta, row.created_at, row.code);
}

export function findRoom(id: string): RoomRow | undefined {
  return getDb().prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined;
}

export function findRoomByName(name: string): RoomRow | undefined {
  return getDb().prepare('SELECT * FROM rooms WHERE name = ?').get(name) as RoomRow | undefined;
}

/** 按邀请码找房间（大小写/分隔符不敏感） */
export function findRoomByCode(code: string): RoomRow | undefined {
  const normalized = normalizeRoomCode(code);
  if (!normalized) return undefined;
  return getDb().prepare('SELECT * FROM rooms WHERE UPPER(code) = ?').get(normalized) as RoomRow | undefined;
}

/** 重置邀请码（旧码立即失效） */
export function rotateRoomCode(id: string): string {
  const d = getDb();
  let code = generateRoomCode();
  while (d.prepare('SELECT 1 AS ok FROM rooms WHERE code = ?').get(code)) {
    code = generateRoomCode();
  }
  d.prepare('UPDATE rooms SET code = ? WHERE id = ?').run(code, id);
  return code;
}

export function listRooms(): RoomRow[] {
  return getDb()
    .prepare('SELECT * FROM rooms ORDER BY created_at ASC')
    .all() as unknown as RoomRow[];
}

export function updateRoom(id: string, patch: Record<string, unknown>): void {
  const allowed = ['name', 'topic', 'meta', 'group_id'];
  const keys = Object.keys(patch).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  getDb()
    .prepare(`UPDATE rooms SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => patch[k] as string | null), id);
}

export function deleteRoom(id: string): void {
  const d = getDb();
  d.prepare('DELETE FROM room_members WHERE room_id = ?').run(id);
  d.prepare('DELETE FROM messages WHERE room_id = ?').run(id);
  d.prepare('DELETE FROM files WHERE room_id = ?').run(id);
  d.prepare('DELETE FROM rooms WHERE id = ?').run(id);
}

/* ------------------------------ 群聊分组 ------------------------------ */

export function listRoomGroups(): RoomGroupRow[] {
  return getDb()
    .prepare('SELECT * FROM room_groups ORDER BY sort ASC, created_at ASC')
    .all() as unknown as RoomGroupRow[];
}

export function getRoomGroup(id: string): RoomGroupRow | undefined {
  return getDb().prepare('SELECT * FROM room_groups WHERE id = ?').get(id) as RoomGroupRow | undefined;
}

export function insertRoomGroup(row: RoomGroupRow): void {
  getDb()
    .prepare('INSERT INTO room_groups (id, name, sort, created_by, created_at) VALUES (?,?,?,?,?)')
    .run(row.id, row.name, row.sort, row.created_by, row.created_at);
}

export function updateRoomGroup(id: string, patch: { name?: string; sort?: number }): void {
  const keys = Object.keys(patch).filter((k) => patch[k as 'name' | 'sort'] !== undefined);
  if (!keys.length) return;
  getDb()
    .prepare(`UPDATE room_groups SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => patch[k as 'name' | 'sort'] as string | number), id);
}

export function nextGroupSort(): number {
  const row = getDb().prepare('SELECT MAX(sort) AS n FROM room_groups').get() as { n: number | null } | undefined;
  return Number(row?.n ?? 0) + 1;
}

/** 删除分组：里面的房间变成「未分组」，房间本身不受影响 */
export function deleteRoomGroup(id: string): number {
  const d = getDb();
  const moved = d.prepare('UPDATE rooms SET group_id = NULL WHERE group_id = ?').run(id);
  d.prepare('DELETE FROM room_groups WHERE id = ?').run(id);
  return Number(moved.changes ?? 0);
}

export function listRoomsInGroup(groupId: string): string[] {
  return (getDb().prepare('SELECT id FROM rooms WHERE group_id = ? ORDER BY created_at ASC').all(groupId) as unknown as Array<{
    id: string;
  }>).map((r) => r.id);
}

export function addRoomMember(roomId: string, tag: string, role = 'member'): void {
  getDb()
    .prepare(
      `INSERT INTO room_members (room_id, tag, role, joined_at) VALUES (?,?,?,?)
       ON CONFLICT (room_id, tag) DO UPDATE SET role = excluded.role`,
    )
    .run(roomId, tag, role, now());
}

export function removeRoomMember(roomId: string, tag: string): void {
  getDb().prepare('DELETE FROM room_members WHERE room_id = ? AND tag = ?').run(roomId, tag);
}

export function isRoomMember(roomId: string, tag: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM room_members WHERE room_id = ? AND tag = ?')
    .get(roomId, tag) as { ok: number } | undefined;
  return Boolean(row);
}

export function listRoomMemberTags(roomId: string): string[] {
  const rows = getDb()
    .prepare('SELECT tag FROM room_members WHERE room_id = ? ORDER BY joined_at ASC')
    .all(roomId) as unknown as Array<{ tag: string }>;
  return rows.map((r) => r.tag);
}

/* --------------------------- 未读游标（已读位置） --------------------------- */

/** 某人某房间「读到哪了」。没人标过就是 0（= 从第一条开始都算未读）。 */
export function getReadCursor(roomId: string, tag: string): number {
  const row = getDb()
    .prepare('SELECT last_read_id FROM room_members WHERE room_id = ? AND tag = ?')
    .get(roomId, tag) as { last_read_id: number | null } | undefined;
  return Number(row?.last_read_id ?? 0) || 0;
}

/** 推进已读游标（只前进、不后退，避免并发把游标拉回去） */
export function setReadCursor(roomId: string, tag: string, upTo: number): number {
  const next = Math.max(getReadCursor(roomId, tag), Math.floor(Number(upTo) || 0));
  getDb()
    .prepare('UPDATE room_members SET last_read_id = ? WHERE room_id = ? AND tag = ?')
    .run(next, roomId, tag);
  return next;
}

export function maxMessageId(roomId: string): number {
  const row = getDb().prepare('SELECT MAX(id) AS n FROM messages WHERE room_id = ?').get(roomId) as
    | { n: number | null }
    | undefined;
  return Number(row?.n ?? 0) || 0;
}

/**
 * 房间里的「裁定」（ruling）：带 data.kind='ruling' 的消息。
 *
 * 存在理由（反馈里那条最贵的事故）：一条结论被证伪、在别处改过了，
 * 但某个脚本/文案里还印着旧结论，没人回来追。数算错会被自检抓住，**文案过期不会**。
 * 所以让"哪条结论还有效"变成可查询的：同一 scope 里最新的那条算 active，其余自动 superseded。
 */
export function listRulingMessages(roomId: string): MessageRow[] {
  return getDb()
    .prepare("SELECT * FROM messages WHERE room_id = ? AND data LIKE '%\"kind\"%' ORDER BY id ASC")
    .all(roomId) as unknown as MessageRow[];
}

/* ------------------------------ messages ------------------------------- */

export function insertMessage(row: Omit<MessageRow, 'id'>): MessageRow {
  const res = getDb()
    .prepare(
      `INSERT INTO messages
        (room_id, sender_tag, sender_nickname, sender_kind, type, text, mentions, files,
         reply_to, chain_id, hop, meta, data, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.room_id,
      row.sender_tag,
      row.sender_nickname,
      row.sender_kind,
      row.type,
      row.text,
      row.mentions,
      row.files,
      row.reply_to,
      row.chain_id,
      row.hop,
      row.meta,
      row.data,
      row.created_at,
    );
  const id = Number(res.lastInsertRowid);
  return { ...row, id };
}

export function getMessage(id: number): MessageRow | undefined {
  return getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id) as
    | MessageRow
    | undefined;
}

/** 改写一条消息的正文（用于「长任务进度」这类同一条消息原地更新，避免刷屏） */
export function updateMessageText(id: number, text: string, meta?: Record<string, unknown>): MessageRow | undefined {
  const d = getDb();
  if (meta) {
    d.prepare('UPDATE messages SET text = ?, meta = ? WHERE id = ?').run(text, JSON.stringify(meta), id);
  } else {
    d.prepare('UPDATE messages SET text = ? WHERE id = ?').run(text, id);
  }
  return getMessage(id);
}

/** 删除一条消息（心跳收尾、撤回等场景） */
export function deleteMessage(id: number): boolean {
  const res = getDb().prepare('DELETE FROM messages WHERE id = ?').run(id);
  return Number(res.changes) > 0;
}

/** 改写一条消息的附件列表（文件被删除时把引用摘掉） */
export function updateMessageFiles(
  id: number,
  files: string[],
  meta?: Record<string, unknown>,
): MessageRow | undefined {
  const d = getDb();
  if (meta) {
    d.prepare('UPDATE messages SET files = ?, meta = ? WHERE id = ?').run(JSON.stringify(files), JSON.stringify(meta), id);
  } else {
    d.prepare('UPDATE messages SET files = ? WHERE id = ?').run(JSON.stringify(files), id);
  }
  return getMessage(id);
}

/**
 * 找出引用了某个文件的消息。用 LIKE 粗筛（JSON 数组里存的是文件 id），
 * 房间消息量不大，够用且不需要额外的关联表。
 */
export function listMessagesWithFile(roomId: string, fileId: string): MessageRow[] {
  return getDb()
    .prepare('SELECT * FROM messages WHERE room_id = ? AND files LIKE ?')
    .all(roomId, `%"${fileId}"%`) as unknown as MessageRow[];
}

/**
 * 收件箱：别人 @ 了我、而我还没回的消息。
 *
 * 给「真正活着的会话」用——那个会话活在它自己的进程里，外部没法把它叫醒，
 * 所以只能由它主动来收（`ah inbox`）。「已回」的判定：这条消息之后，
 * 我在同一个房间发过言（不要求 replyTo 指回来，说话就算处理过了）。
 */
export function listMentionsFor(
  tag: string,
  opts: { limit?: number; since?: number; includeAnswered?: boolean; roomId?: string } = {},
): Array<{ message: MessageRow; roomName: string; answered: boolean; myReplyId: number | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const params: Array<string | number> = [tag, `%"${tag}"%`, tag];
  let where = 'rm.tag = ? AND m.mentions LIKE ? AND m.sender_tag != ?';
  if (opts.since) {
    where += ' AND m.created_at >= ?';
    params.push(opts.since);
  }
  if (opts.roomId) {
    where += ' AND m.room_id = ?';
    params.push(opts.roomId);
  }
  const rows = getDb()
    .prepare(
      `SELECT m.*, r.name AS room_name
         FROM messages m
         JOIN room_members rm ON rm.room_id = m.room_id
         JOIN rooms r ON r.id = m.room_id
        WHERE ${where}
        ORDER BY m.id DESC
        LIMIT ?`,
    )
    .all(...params, limit) as unknown as Array<MessageRow & { room_name: string }>;

  const replyStmt = getDb().prepare(
    "SELECT id FROM messages WHERE room_id = ? AND sender_tag = ? AND id > ? AND sender_kind != 'system' ORDER BY id LIMIT 1",
  );
  const items = rows.map((row) => {
    const reply = replyStmt.get(row.room_id, tag, row.id) as { id: number } | undefined;
    const { room_name: roomName, ...message } = row;
    return {
      message: message as MessageRow,
      roomName,
      answered: Boolean(reply),
      myReplyId: reply?.id ?? null,
    };
  });
  return opts.includeAnswered ? items : items.filter((item) => !item.answered);
}

export interface HistoryQuery {
  roomId: string;
  limit?: number;
  before?: number;
  after?: number;
  search?: string;
  sender?: string;
  /** 排除某个人自己发的消息（未读游标用：别人的发言才是「未读」） */
  excludeSender?: string;
}

export function listMessages(q: HistoryQuery): MessageRow[] {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const params: Array<string | number> = [q.roomId];
  let where = 'room_id = ?';
  if (q.before) {
    where += ' AND id < ?';
    params.push(q.before);
  }
  if (q.after) {
    where += ' AND id > ?';
    params.push(q.after);
  }
  if (q.sender) {
    where += ' AND sender_tag = ?';
    params.push(q.sender);
  }
  if (q.excludeSender) {
    where += ' AND sender_tag != ?';
    params.push(q.excludeSender);
  }
  if (q.search) {
    where += ' AND text LIKE ?';
    params.push(`%${q.search}%`);
  }
  if (q.after) {
    // 追赶历史：正序取最早的 limit 条
    const rows = getDb()
      .prepare(`SELECT * FROM messages WHERE ${where} ORDER BY id ASC LIMIT ?`)
      .all(...params, limit) as unknown as MessageRow[];
    return rows;
  }
  const rows = getDb()
    .prepare(`SELECT * FROM messages WHERE ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as unknown as MessageRow[];
  return rows.reverse();
}

export function roomMessageCount(roomId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE room_id = ?')
    .get(roomId) as { n: number };
  return row.n;
}

/* -------------------------------- files -------------------------------- */

export function insertFile(row: FileRow): void {
  getDb()
    .prepare(
      `INSERT INTO files (id, room_id, name, size, mime, uploader_tag, sha256, stored_path,
                          version, previous_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.id,
      row.room_id,
      row.name,
      row.size,
      row.mime,
      row.uploader_tag,
      row.sha256,
      row.stored_path,
      row.version,
      row.previous_id,
      row.created_at,
    );
}

/** 同一房间内同名的上一版（用来做版本链） */
export function latestFileByName(roomId: string, name: string): FileRow | undefined {
  return getDb()
    .prepare('SELECT * FROM files WHERE room_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1')
    .get(roomId, name) as FileRow | undefined;
}

export function getFile(id: string): FileRow | undefined {
  return getDb().prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
}

export function listFiles(roomId: string): FileRow[] {
  return getDb()
    .prepare('SELECT * FROM files WHERE room_id = ? ORDER BY created_at DESC')
    .all(roomId) as unknown as FileRow[];
}

export function deleteFile(id: string): void {
  getDb().prepare('DELETE FROM files WHERE id = ?').run(id);
}

export interface RoomArtifactCounts {
  members: number;
  messages: number;
  files: number;
  runs: number;
}

/** 房间相关的数据量（解散前先报个数，让人知道删掉的是什么） */
export function roomArtifactCounts(roomId: string): RoomArtifactCounts {
  const one = (sql: string): number =>
    Number((getDb().prepare(sql).get(roomId) as { n: number } | undefined)?.n ?? 0);
  return {
    members: one('SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?'),
    messages: one('SELECT COUNT(*) AS n FROM messages WHERE room_id = ?'),
    files: one('SELECT COUNT(*) AS n FROM files WHERE room_id = ?'),
    runs: one('SELECT COUNT(*) AS n FROM agent_runs WHERE room_id = ?'),
  };
}

/**
 * 解散房间：把这个房间在数据库里的痕迹全部清掉——成员关系、消息记录、文件记录、
 * AI 运行记录（里面存着完整提示词与输出，同样属于聊天存档）、房间本身。
 * 磁盘上的文件由 files.ts 的 purgeRoomFiles 负责，这里只管数据库。
 */
export function purgeRoomRows(roomId: string): RoomArtifactCounts {
  const d = getDb();
  const counts = roomArtifactCounts(roomId);
  record('db.purge.begin', `${roomId} messages=${counts.messages} files=${counts.files}`);
  flushNow();
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM room_members WHERE room_id = ?').run(roomId);
    d.prepare('DELETE FROM messages WHERE room_id = ?').run(roomId);
    d.prepare('DELETE FROM files WHERE room_id = ?').run(roomId);
    d.prepare('DELETE FROM agent_runs WHERE room_id = ?').run(roomId);
    d.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  record('db.purge.done', roomId);
  return counts;
}

/* ------------------------------ agent runs ----------------------------- */

export function insertRun(
  row: Omit<RunRow, 'finished_at' | 'tokens_in' | 'tokens_out' | 'tokens_total' | 'cost_usd'>,
): void {
  getDb()
    .prepare(
      `INSERT INTO agent_runs
        (id, room_id, agent_tag, trigger_msg, chain_id, hop, status, adapter_id, exit_code,
         duration_ms, error, prompt, output, created_at, finished_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
    )
    .run(
      row.id,
      row.room_id,
      row.agent_tag,
      row.trigger_msg,
      row.chain_id,
      row.hop,
      row.status,
      row.adapter_id,
      row.exit_code,
      row.duration_ms,
      row.error,
      row.prompt,
      row.output,
      row.created_at,
    );
}

export function finishRun(
  id: string,
  patch: {
    status: string;
    exit_code?: number | null;
    duration_ms?: number | null;
    error?: string | null;
    output?: string;
    tokens_in?: number | null;
    tokens_out?: number | null;
    tokens_total?: number | null;
    cost_usd?: number | null;
  },
): void {
  getDb()
    .prepare(
      `UPDATE agent_runs SET status = ?, exit_code = ?, duration_ms = ?, error = ?, output = ?, finished_at = ?,
              tokens_in = ?, tokens_out = ?, tokens_total = ?, cost_usd = ?
       WHERE id = ?`,
    )
    .run(
      patch.status,
      patch.exit_code ?? null,
      patch.duration_ms ?? null,
      patch.error ?? null,
      patch.output ?? '',
      now(),
      patch.tokens_in ?? null,
      patch.tokens_out ?? null,
      patch.tokens_total ?? null,
      patch.cost_usd ?? null,
      id,
    );
}

/**
 * 用量汇总（按 agent / 房间 / 天）：token 统计靠 CLI 自报，没报的调用不会计入，
 * 所以返回里带上 runs / measuredRuns 两个数，避免把「没报」当成「没用」。
 */
export function usageSummary(q: { roomId?: string; since?: number; byTag?: string }): Array<Record<string, unknown>> {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (q.roomId) {
    where.push('room_id = ?');
    params.push(q.roomId);
  }
  if (q.byTag) {
    where.push('agent_tag = ?');
    params.push(q.byTag);
  }
  if (q.since) {
    where.push('created_at >= ?');
    params.push(q.since);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(
      `SELECT agent_tag,
              COUNT(*) AS runs,
              SUM(CASE WHEN tokens_total IS NOT NULL THEN 1 ELSE 0 END) AS measured_runs,
              SUM(COALESCE(tokens_in, 0)) AS tokens_in,
              SUM(COALESCE(tokens_out, 0)) AS tokens_out,
              SUM(COALESCE(tokens_total, 0)) AS tokens_total,
              SUM(COALESCE(cost_usd, 0)) AS cost_usd,
              SUM(COALESCE(duration_ms, 0)) AS duration_ms
         FROM agent_runs ${clause}
        GROUP BY agent_tag
        ORDER BY tokens_total DESC`,
    )
    .all(...params) as unknown as Array<Record<string, unknown>>;
  return rows;
}

export function listRuns(agentTag: string, limit = 20): RunRow[] {
  return getDb()
    .prepare('SELECT * FROM agent_runs WHERE agent_tag = ? ORDER BY created_at DESC LIMIT ?')
    .all(agentTag, Math.min(Math.max(limit, 1), 200)) as unknown as RunRow[];
}

export function getRun(id: string): RunRow | undefined {
  return getDb().prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as RunRow | undefined;
}
