#!/usr/bin/env node
/**
 * 一条命令跑出可看的演示：建一个演示房间、拉进 3 个 AI、发起一场讨论，并把聊天记录打印出来。
 *
 *   node scripts/demo.mjs                 # 用内置 mock 适配器（离线、秒回）
 *   node scripts/demo.mjs --adapter codex # 让其中一个 AI 用真实 Codex CLI（慢，会消耗额度）
 */
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const SERVER = flag('server', process.env.AH_SERVER ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ROOM = flag('room', '演示群聊');
const REAL_ADAPTER = flag('adapter', null);
const RUN = Date.now().toString(36).slice(-4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tokens = {};

async function api(pathname, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${SERVER}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status} ${data.error ?? ''}`);
  return data;
}

async function ensureMember(tag, nickname, extra = {}) {
  try {
    const res = await api('/api/register', {
      method: 'POST',
      body: { tag, nickname, ...extra },
    });
    tokens[tag] = res.token;
    return res.member;
  } catch (err) {
    if (!String(err.message).includes('409')) throw err;
    // 已存在：从本地 profile 或环境变量里找 token
    const fallback = process.env[`AH_TOKEN_${tag.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
    if (!fallback) {
      throw new Error(`@${tag} 已存在，但没找到它的 token。删掉 data/agenthub.db 重来，或设置环境变量 AH_TOKEN_${tag.toUpperCase()}`);
    }
    tokens[tag] = fallback;
    return { tag, nickname };
  }
}

async function cli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, 'server', 'bin', 'ah.mjs'), ...args], {
      env: { ...process.env, AH_SERVER: SERVER, NO_COLOR: '1', ...env },
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    child.on('close', () => resolve(out.trim()));
  });
}

console.log(`\n=== AgentHub 演示 ===\n服务：${SERVER}\n房间：${ROOM}\n`);

const alice = `demo-${RUN}`;
await ensureMember(alice, '演示用户');
await ensureMember(`codex-${RUN}`, 'Codex 一号', { kind: 'agent', adapterId: REAL_ADAPTER ?? 'mock', agentKind: 'codex' });
await ensureMember(`claude-${RUN}`, 'Claude 小助手', { kind: 'agent', adapterId: 'mock', agentKind: 'claude' });
await ensureMember(`local-${RUN}`, '本地模型', { kind: 'agent', adapterId: 'ollama', agentKind: 'ollama' });
console.log('已注册：演示用户 + 3 个 AI 成员（mock / mock / 本地 Ollama）');

const roomTags = [`codex-${RUN}`, `claude-${RUN}`, `local-${RUN}`];
await api('/api/rooms', {
  method: 'POST',
  token: tokens[alice],
  body: { name: ROOM, topic: '演示：人 + 多个 AI 协作', members: roomTags },
});
console.log(`房间「${ROOM}」已创建，成员：@${alice} + ${roomTags.map((t) => '@' + t).join(' ')}`);

console.log('\n→ 发送一条消息并 @Codex 一号（它会自己和别的 AI 接力）…');
await api(`/api/rooms/${encodeURIComponent(ROOM)}/messages`, {
  method: 'POST',
  token: tokens[alice],
  body: { text: `@codex-${RUN} 我们在做一个多 AI 群聊工具，你觉得最该先解决什么问题？` },
});
await sleep(6000);

console.log('\n→ 发起一场 1 轮的多 AI 讨论…');
await api(`/api/rooms/${encodeURIComponent(ROOM)}/discuss`, {
  method: 'POST',
  token: tokens[alice],
  body: { topic: '共享文件区应该怎么设计权限', tags: [`codex-${RUN}`, `claude-${RUN}`], rounds: 1 },
});
await sleep(8000);

const transcript = await cli(['history', '--room', ROOM, '--limit', '40'], {
  AH_TAG: alice,
  AH_TOKEN: tokens[alice],
});
console.log(`\n=== 聊天记录（ah history --room ${ROOM}）===\n${transcript}`);

console.log(`\n演示结束。继续体验：`);
console.log(`  1) 打开网页 http://localhost:5173 ，用 token 登录 @${alice}`);
console.log(`     token: ${tokens[alice]}`);
console.log(`  2) 实时看新消息：node server/bin/ah.mjs tail --room "${ROOM}" --tag ${alice} --token ${tokens[alice]}`);
console.log('');
