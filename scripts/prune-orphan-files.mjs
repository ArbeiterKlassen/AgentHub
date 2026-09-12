#!/usr/bin/env node
/**
 * 清理「房间已经没了、文件还躺在磁盘上」的孤儿存档（默认只预览，--apply 才真删）。
 *
 *   node scripts/prune-orphan-files.mjs           # 预览
 *   node scripts/prune-orphan-files.mjs --apply   # 真删
 *
 * 背景：早期的「解散房间」只删数据库行，磁盘上的 data/files/<房间>/ 不会跟着删，
 * 于是删房越多、磁盘上留下的死文件越多（本机实测：库里 5 个房间、磁盘上 34 个目录）。
 * 现在解散房间会连磁盘一起清（见 server/src/files.ts 的 purgeRoomFiles），
 * 这个脚本负责收拾历史遗留，以及将来万一删到一半失败留下的残渣。
 *
 * 判断标准：data/files/<id> 里的 <id> 不在 rooms 表里 → 孤儿。
 * 只会删 data/files 下面的目录，脚本自己不做任何跨目录操作。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.AH_DATA_DIR ?? path.join(REPO, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const DB_PATH = path.join(DATA_DIR, 'agenthub.db');
const APPLY = process.argv.includes('--apply');

if (!fs.existsSync(FILES_DIR)) {
  console.log(`没有文件目录：${FILES_DIR}`);
  process.exit(0);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`找不到数据库：${DB_PATH}（AH_DATA_DIR 可指定数据目录）`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const liveRooms = new Set(db.prepare('SELECT id FROM rooms').all().map((r) => r.id));
const dirRows = fs
  .readdirSync(FILES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const orphans = dirRows.filter((name) => !liveRooms.has(name));
if (!orphans.length) {
  console.log(`没有孤儿目录（数据库 ${liveRooms.size} 个房间 / 磁盘 ${dirRows.length} 个目录）`);
  process.exit(0);
}

let files = 0;
let bytes = 0;
for (const name of orphans) {
  const dir = path.join(FILES_DIR, name);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += fs.statSync(path.join(dir, entry.name)).size;
  }
}

const mb = (n) => (n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
console.log(
  `数据库里有 ${liveRooms.size} 个房间，磁盘上有 ${dirRows.length} 个目录；` +
    `其中 ${orphans.length} 个是孤儿（${files} 个文件 / ${mb(bytes)}）：\n` +
    orphans.map((n) => `  ${n}`).join('\n'),
);

if (!APPLY) {
  console.log('\n以上是预览。确认无误后加 --apply 执行。');
  process.exit(0);
}

const root = path.resolve(FILES_DIR) + path.sep;
let removed = 0;
for (const name of orphans) {
  const dir = path.resolve(path.join(FILES_DIR, name));
  if (!dir.startsWith(root)) {
    console.warn(`跳过越界路径：${dir}`);
    continue;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  removed += 1;
}
console.log(`\n✅ 已删除 ${removed} 个孤儿目录，回收 ${mb(bytes)}`);
