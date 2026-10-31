#!/usr/bin/env node
/**
 * 回归：正文里带 @tag 的系统消息不该进收件箱。
 *
 * 背景：/api/inbox 的 SQL 是 `m.mentions LIKE ?`，而系统消息（成员加入、运行进度、
 * 上传提示）也会扫 @ 并写进 mentions。不排除 sender_kind='system' 的话，一条系统消息
 * 就能把值守进程叫醒，与「系统消息不叫醒你」的承诺相反。
 *
 * 做法：起隔离实例 → 注册两个成员 + 建房间 → 直接往库里插一条 system 消息（HTTP 层没有
 * 「以系统身份发消息」的入口）→ 断言收件箱里看不到它，而人发的 @ 消息看得到。
 *
 * 跑完自动清理。需要 server/dist 已构建。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DATA = path.join(ROOT, 'data', 'tmp', 'inbox-system-data');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-inbox-home-'));

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `（拿到 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitReady(base, ms = 20_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > until) throw new Error(`服务没起来：${base}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function api(base, pathname, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

const port = await freePort();
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(ROOT, 'server', 'dist', 'index.js')], {
  cwd: ROOT,
  env: { ...process.env, AH_PORT: String(port), AH_HOST: '127.0.0.1', AH_DATA_DIR: DATA },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});

let code = 1;
try {
  await waitReady(base);
  console.log(`PASS 服务已起 ${base}`);

  const me = (await api(base, '/api/register', {
    method: 'POST',
    body: { tag: 'inbox-me', nickname: '收件箱用户', kind: 'agent' },
  })).json;
  const other = (await api(base, '/api/register', {
    method: 'POST',
    body: { tag: 'inbox-other', nickname: '说话的人', kind: 'agent' },
  })).json;

  const room = (await api(base, '/api/rooms', {
    method: 'POST',
    token: me.token,
    body: { name: '收件箱系统消息房间' },
  })).json;
  const roomName = room.room?.name ?? room.name;
  const members = (await api(base, `/api/rooms/${encodeURIComponent(roomName)}/members`, {
    method: 'POST',
    token: me.token,
    body: { tag: 'inbox-other', role: 'member' },
  })).status;
  await api(base, `/api/rooms/${encodeURIComponent(roomName)}/members`, {
    method: 'POST',
    token: other.token,
    body: { tag: 'inbox-me', role: 'member' },
  });

  const roomId = room.room?.id ?? room.id;

  // 人发的 @ 消息：应该进收件箱
  await api(base, `/api/rooms/${encodeURIComponent(roomName)}/messages`, {
    method: 'POST',
    token: other.token,
    body: { text: '@inbox-me 这条是人发的' },
  });

  // 系统消息带 @：不该进收件箱。HTTP 层没有「以系统身份发消息」的入口，直接写库。
  const db = new DatabaseSync(path.join(DATA, 'agenthub.db'));
  db.prepare(
    `INSERT INTO messages (room_id, sender_tag, sender_nickname, sender_kind, type, text, mentions, created_at)
     VALUES (?, 'system', '系统', 'system', 'text', ?, ?, ?)`,
  ).run(roomId, '@inbox-me 运行超时（系统消息）', JSON.stringify(['inbox-me']), Date.now());
  db.close();

  const inbox = (await api(base, `/api/inbox?minutes=720&limit=20`, { token: me.token })).json;
  const items = inbox.items ?? [];
  const texts = items.map((i) => i.message.text);
  check('收件箱里有人发的 @ 消息', texts.some((t) => t.includes('这条是人发的')), true);
  check('收件箱里没有系统消息', texts.some((t) => t.includes('运行超时')), false);
  check('成员加入成功', members === 200 || members === 201, true);

  code = failed ? 1 : 0;
} catch (err) {
  console.error('异常：', err?.message ?? err);
  code = 1;
} finally {
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项不通过` : '\nALL PASS');
process.exit(code);
