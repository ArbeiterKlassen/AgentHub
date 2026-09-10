#!/usr/bin/env node
/**
 * 直接读 SQLite 查看群聊数据（不走 HTTP，排查问题时很有用）
 *
 *   node scripts/db-dump.mjs                       # 列出所有房间
 *   node scripts/db-dump.mjs --room general        # 打印某房间最近 50 条消息
 *   node scripts/db-dump.mjs --room general -n 200 --json
 *   node scripts/db-dump.mjs --members             # 列出所有成员与 token
 *   node scripts/db-dump.mjs --runs                # 最近的 AI 运行记录
 */
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.AH_DATA_DIR ?? path.join(repo, 'data');
const db = new DatabaseSync(path.join(dataDir, 'agenthub.db'));

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const json = Boolean(flag('json', false));
const limit = Number(flag('n', flag('limit', 50)));

if (flag('members')) {
  const rows = db.prepare('SELECT * FROM members ORDER BY created_at').all();
  if (json) console.log(JSON.stringify(rows, null, 2));
  else
    for (const m of rows) {
      console.log(
        `${m.kind === 'agent' ? 'AI ' : '人 '} @${m.tag.padEnd(16)} ${m.nickname.padEnd(12)} ` +
          `${(m.agent_kind ?? '').padEnd(10)} adapter=${(m.adapter_id ?? '-').padEnd(10)} ` +
          `${m.role.padEnd(6)} trigger=${m.trigger_mode.padEnd(8)} token=${m.token_secret}`,
      );
    }
  process.exit(0);
}

if (flag('runs')) {
  const rows = db
    .prepare('SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?')
    .all(limit);
  if (json) console.log(JSON.stringify(rows, null, 2));
  else
    for (const r of rows) {
      console.log(
        `${new Date(r.created_at).toLocaleString()} ${r.status.padEnd(8)} @${r.agent_tag.padEnd(14)} ` +
          `${(r.adapter_id ?? '').padEnd(10)} ${String(r.duration_ms ?? '').padStart(7)}ms ` +
          `${r.error ? `ERR ${r.error.slice(0, 60)}` : ''}`,
      );
    }
  process.exit(0);
}

const roomName = flag('room');
if (!roomName) {
  const rooms = db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM messages m WHERE m.room_id = r.id) AS msgs,
              (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) AS members
       FROM rooms r ORDER BY r.created_at`,
    )
    .all();
  if (json) console.log(JSON.stringify(rooms, null, 2));
  else
    for (const r of rooms) {
      console.log(`${r.name.padEnd(18)} ${r.id}  成员 ${r.members}  消息 ${r.msgs}  「${r.topic}」`);
    }
  process.exit(0);
}

const room = db.prepare('SELECT * FROM rooms WHERE name = ? OR id = ?').get(roomName, roomName);
if (!room) {
  console.error(`房间 ${roomName} 不存在`);
  process.exit(1);
}
const rows = db
  .prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?')
  .all(room.id, limit)
  .reverse();
if (json) console.log(JSON.stringify(rows, null, 2));
else
  for (const m of rows) {
    console.log(
      `${String(m.id).padStart(4)} ${new Date(m.created_at).toLocaleTimeString()} ` +
        `${(m.chain_id ?? '-').slice(0, 12).padEnd(12)} hop=${String(m.hop).padEnd(2)} ` +
        `${m.sender_kind.padEnd(6)} @${m.sender_tag.padEnd(14)} | ${String(m.text).replace(/\n/g, ' ').slice(0, 110)}`,
    );
  }
