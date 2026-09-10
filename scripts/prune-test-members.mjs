#!/usr/bin/env node
/**
 * 清理自检/演示留下的空号成员（默认只预览，--apply 才真删）。
 *
 *   node scripts/prune-test-members.mjs                      # 预览会被删掉的成员
 *   node scripts/prune-test-members.mjs --apply              # 真正删除
 *   node scripts/prune-test-members.mjs --pattern "a0i9$" --apply
 *   node scripts/prune-test-members.mjs --apply --force      # 连"还在房间/有发言"的也删
 *
 * 默认只匹配自检脚本会生成的 tag 形如 alice-xxxx / codex-xxxx / claude-xxxx / loop-xxxx /
 * ui-xxxx / demo-xxxx，并且要求「0 个房间 且 0 条发言」，真人身份不会被误伤。
 * 执行 --apply 前会自动把数据库备份到 data/_backup/。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.AH_DATA_DIR ?? path.join(REPO, 'data');
const DB_PATH = path.join(DATA_DIR, 'agenthub.db');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const APPLY = Boolean(flag('apply', false));
const FORCE = Boolean(flag('force', false));
const PATTERN = String(flag('pattern', '^(alice|codex|claude|loop|ui|demo|test)-[a-z0-9]{4,}$'));
const re = new RegExp(PATTERN);

// 顺带清理自检房间（房间名默认匹配 e2e-* / UI 验证*）
const ROOM_PATTERN = String(flag('rooms-pattern', '^(e2e-|UI 验证)'));
const roomRe = new RegExp(ROOM_PATTERN);

let backedUp = false;
function backupDatabase() {
  if (backedUp) return;
  const backupDir = path.join(DATA_DIR, '_backup');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const backupPath = path.join(backupDir, `agenthub.db.${stamp}.prune`);
  fs.copyFileSync(DB_PATH, backupPath);
  backedUp = true;
  console.log(`已备份数据库：${path.relative(REPO, backupPath)}`);
}

const db = new DatabaseSync(DB_PATH, { readOnly: !APPLY });
const roomRows = db.prepare('SELECT id, name FROM rooms ORDER BY created_at').all();
const roomCandidates = roomRows.filter((r) => roomRe.test(r.name));
if (roomCandidates.length) {
  console.log(`匹配到 ${roomCandidates.length} 个自检房间：${roomCandidates.map((r) => r.name).join('、')}`);
}

// 先备份（apply 时），再删房间，最后基于「删完房间之后」的数据判断哪些成员是空号
let writer = null;
if (APPLY && roomCandidates.length) {
  backupDatabase();
  writer = new DatabaseSync(DB_PATH);
  for (const room of roomCandidates) {
    writer.prepare('DELETE FROM messages WHERE room_id = ?').run(room.id);
    writer.prepare('DELETE FROM room_members WHERE room_id = ?').run(room.id);
    writer.prepare('DELETE FROM files WHERE room_id = ?').run(room.id);
    writer.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
  }
  console.log(`已删除 ${roomCandidates.length} 个自检房间`);
}

const rows = db
  .prepare(
    `SELECT m.tag, m.nickname, m.kind, m.created_at,
            (SELECT COUNT(*) FROM room_members rm WHERE rm.tag = m.tag) AS rooms,
            (SELECT COUNT(*) FROM messages msg WHERE msg.sender_tag = m.tag) AS msgs
       FROM members m ORDER BY m.created_at`,
  )
  .all();

const isTestTag = (tag) => re.test(tag);
const candidates = rows.filter((r) => isTestTag(r.tag) && (FORCE || (r.rooms === 0 && r.msgs === 0)));
const protectedRows = rows.filter((r) => isTestTag(r.tag) && !candidates.includes(r));

console.log(`成员总数 ${rows.length}｜匹配测试 tag ${rows.filter((r) => isTestTag(r.tag)).length} 个｜将清理 ${candidates.length} 个`);
for (const r of candidates) {
  console.log(`  ${APPLY ? '删除' : '待删'} @${String(r.tag).padEnd(18)} ${r.nickname}（房间 ${r.rooms}｜发言 ${r.msgs}）`);
}
for (const r of protectedRows) {
  console.log(`  跳过 @${String(r.tag).padEnd(18)} ${r.nickname}（房间 ${r.rooms}｜发言 ${r.msgs}，加 --force 才会删）`);
}

if (!candidates.length) {
  console.log('没有需要清理的成员');
  process.exit(0);
}

if (!APPLY) {
  console.log('\n这是预览。要真正删除，加 --apply 再跑一次。');
  process.exit(0);
}

backupDatabase();
writer = new DatabaseSync(DB_PATH);
let removed = 0;
for (const r of candidates) {
  writer.prepare('DELETE FROM room_members WHERE tag = ?').run(r.tag);
  writer.prepare('DELETE FROM agent_runs WHERE agent_tag = ?').run(r.tag);
  writer.prepare('DELETE FROM members WHERE tag = ?').run(r.tag);
  removed += 1;
}
writer.close();
console.log(`已删除 ${removed} 个测试成员`);
const left = new DatabaseSync(DB_PATH, { readOnly: true })
  .prepare('SELECT COUNT(*) AS n FROM members')
  .get().n;
console.log(`剩余成员 ${left} 个`);
