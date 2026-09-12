#!/usr/bin/env node
/**
 * 改成员的角色（admin / member）——默认只预览，加 --apply 才真写库。
 *
 *   node scripts/set-role.mjs                                 # 列出所有人的角色
 *   node scripts/set-role.mjs --tag tianxu --role admin        # 预览这次改动
 *   node scripts/set-role.mjs --tag tianxu --role admin --apply # 真的改
 *
 * 为什么要单独一个脚本：角色只在注册时赋值（第一个注册的人是 admin），之后**没有** API 能改它——
 * 提权做成公开接口是个不该有的攻击面。所以改角色只能在服务所在机器上用这个脚本做。
 * 改完对方刷新页面（或重新登录）即可生效，不需要重启服务。
 *
 * 管理员（role=admin）能做什么：
 *   修改任意成员资料、查看/重置任意成员的 token、删除任意成员、删任意房间、
 *   把自己以外的成员踢出任意房间、删除任意消息与文件、查看/导出任意房间的历史。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.AH_DATA_DIR ?? path.join(REPO, 'data');
const DB_PATH = path.join(DATA_DIR, 'agenthub.db');
const ROLES = ['admin', 'member'];

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const APPLY = Boolean(flag('apply', false));
const TAG = flag('tag', null) ? String(flag('tag')).toLowerCase() : null;
const ROLE = flag('role', null) ? String(flag('role')).toLowerCase() : null;

if (!fs.existsSync(DB_PATH)) {
  console.error(`找不到数据库：${DB_PATH}（AH_DATA_DIR 可指定数据目录）`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH, { readOnly: !APPLY });
const members = db
  .prepare('SELECT tag, nickname, kind, role, adapter_id FROM members ORDER BY role, kind, tag')
  .all();

const line = (m) =>
  `  ${m.role === 'admin' ? '★' : ' '} @${String(m.tag).padEnd(18)} ${String(m.nickname ?? '').padEnd(16)} ` +
  `${m.kind === 'agent' ? `AI/${m.adapter_id ?? '-'}` : '人类'}`;

if (!TAG || !ROLE) {
  console.log(`成员角色（★ = 管理员，共 ${members.length} 人）\n${members.map(line).join('\n')}`);
  console.log(
    '\n改角色：node scripts/set-role.mjs --tag <tag> --role admin|member [--apply]\n' +
      '（不加 --apply 只预览，不会写库）',
  );
  process.exit(0);
}

if (!ROLES.includes(ROLE)) {
  console.error(`role 只能是 ${ROLES.join(' / ')}，收到「${ROLE}」`);
  process.exit(1);
}

const target = members.find((m) => m.tag === TAG);
if (!target) {
  console.error(`没有找到 tag「${TAG}」。可用 tag：\n${members.map(line).join('\n')}`);
  process.exit(1);
}

if (target.role === ROLE) {
  console.log(`@${TAG} 已经是 ${ROLE}，无需改动。`);
  process.exit(0);
}

const admins = members.filter((m) => m.role === 'admin');
console.log(`@${target.tag}（${target.nickname}）：${target.role} → ${ROLE}`);
if (ROLE === 'member' && admins.length === 1 && admins[0].tag === target.tag) {
  console.log('⚠ 这是最后一个管理员，降级后将没人能删除成员/房间（只能再跑这个脚本改回来）。');
}

if (!APPLY) {
  console.log('\n以上是预览。确认无误后加 --apply 执行。');
  process.exit(0);
}

/* 写库前先备份（与 prune-test-members.mjs 同一套做法） */
const backupDir = path.join(DATA_DIR, '_backup');
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupPath = path.join(backupDir, `agenthub.db.${stamp}.role`);
fs.copyFileSync(DB_PATH, backupPath);
console.log(`已备份数据库：${path.relative(REPO, backupPath)}`);

db.prepare('UPDATE members SET role = ? WHERE tag = ?').run(ROLE, target.tag);
const after = db.prepare('SELECT tag, role FROM members WHERE tag = ?').get(target.tag);
console.log(`✅ 已把 @${after.tag} 设为 ${after.role}（对方刷新页面或重新登录后生效）`);
db.close();
