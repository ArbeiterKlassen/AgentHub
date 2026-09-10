#!/usr/bin/env node
/**
 * @全体（群发）行为自检 —— 建议打临时实例，不要打正在用的房间。
 *
 *   node scripts/verify-mention-all.mjs [--server http://127.0.0.1:8793]
 *
 * 覆盖：
 *   1) @all 唤醒房间里所有 AI（返回排队数 = AI 数，且每个 AI 都真的回帖）
 *   2) @全体 / @所有人 等等价写法同样生效
 *   3) mail@all.com 这类邮箱不误触发，也不唤醒任何 AI
 *   4) 单人 @tag 仍然只唤醒一个 AI（回归）
 *   5) 本轮发言额度不足时，@all 按成员顺序截断入队并给出系统提示，而不是整条链停摆
 */
import process from 'node:process';

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const SERVER = argValue('server', process.env.AH_SERVER ?? 'http://127.0.0.1:8793').replace(/\/+$/, '');
const RUN = Date.now().toString(36).slice(-4);

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
}

async function api(pathname, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(`${SERVER}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data };
}

const tokens = {};
async function register(tag, nickname, extra = {}) {
  const res = await api('/api/register', { method: 'POST', body: { tag, nickname, ...extra } });
  if (!res.ok) throw new Error(`注册 ${tag} 失败：${res.status} ${JSON.stringify(res.data)}`);
  tokens[tag] = res.data.token;
  return res.data.member;
}

const me = `alice-${RUN}`;
const AGENTS = [`mock-a-${RUN}`, `mock-b-${RUN}`, `mock-c-${RUN}`];

async function fetchMessages(room, limit = 200) {
  const res = await api(`/api/rooms/${room}/messages?limit=${limit}`, { token: tokens[me] });
  return res.data.messages ?? [];
}

async function send(room, text) {
  const res = await api(`/api/rooms/${room}/messages`, { method: 'POST', token: tokens[me], body: { text } });
  if (!res.ok) throw new Error(`发消息失败：${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}

async function waitFor(fn, { timeoutMs = 30000, intervalMs = 300, label = '条件满足' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(intervalMs);
  }
}

async function run() {
  console.log(`\n=== @全体 自检 ===\n服务：${SERVER}\n`);

  const health = await api('/api/health');
  check('服务可用 /api/health', health.ok && health.data.ok, `Node ${health.data.node}`);
  const mockProbe = health.data.adapters?.find((a) => a.id === 'mock');
  check('mock 适配器可用（离线跑测试用）', Boolean(mockProbe?.available), mockProbe?.detail ?? '');

  await register(me, '测试人类');
  for (const [i, tag] of AGENTS.entries()) {
    await register(tag, `模拟 AI ${i + 1}`, { kind: 'agent', adapterId: 'mock', agentKind: 'mock' });
  }

  /* 1. @all 唤醒全员 */
  const room = `all-${RUN}`;
  const created = await api('/api/rooms', {
    method: 'POST',
    token: tokens[me],
    body: { name: room, topic: '@全体 自检', members: AGENTS },
  });
  check('创建房间并加入 3 个 AI', created.ok && created.data.room.memberCount === 4, room);

  const all = await send(room, '@all 全体报到，收到请回一个字');
  check('@all 入队数 = 房间 AI 数（3）', all.queued === 3, `queued=${all.queued}`);

  const replies = await waitFor(async () => {
    const msgs = await fetchMessages(room);
    const hit = AGENTS.filter((tag) => msgs.some((m) => m.senderTag === tag));
    return hit.length === AGENTS.length ? hit : null;
  }, { label: '等待 3 个 AI 全部回帖' });
  check('3 个 AI 都真的回帖（不只是入队）', replies.length === 3, replies.join(' '));

  /* 2. 中文写法 @全体 */
  const zh = await send(room, '@全体 第二轮，同样全部唤醒');
  check('@全体 等价写法生效', zh.queued === 3, `queued=${zh.queued}`);

  /* 3. 邮箱不误触发 */
  const before = (await fetchMessages(room)).length;
  const mail = await send(room, '请发到 mail@all.com 这个邮箱，不要群发');
  check('mail@all.com 不触发群发', mail.queued === 0, `queued=${mail.queued}`);
  await sleep(2500);
  const after = await fetchMessages(room);
  check(
    '邮箱消息没有唤醒任何 AI',
    after.filter((m) => m.id > mail.message.id && m.senderKind === 'agent').length === 0,
    `新增 ${after.filter((m) => m.id > mail.message.id && m.senderKind === 'agent').length} 条 AI 回帖（参考 before=${before}）`,
  );

  /* 4. 单人 @tag 回归 */
  const single = await send(room, `@${AGENTS[1]} 只叫你一个`);
  check('单人 @tag 只入队 1 个', single.queued === 1, `queued=${single.queued}`);

  /* 5. 额度不足时的截断 */
  const small = `all-limit-${RUN}`;
  await api('/api/rooms', {
    method: 'POST',
    token: tokens[me],
    body: { name: small, topic: '额度截断自检', members: AGENTS, meta: { maxTurnsPerChain: 2 } },
  });
  const trimmed = await send(small, '@all 本轮额度只有 2 条');
  check('额度不足时 @all 按序截断入队（2/3）', trimmed.queued === 2, `queued=${trimmed.queued}`);
  const notice = await waitFor(async () => {
    const msgs = await fetchMessages(small);
    return msgs.find((m) => m.senderKind === 'system' && m.text.includes('@全体 只入队'));
  }, { timeoutMs: 8000, label: '等待截断提示' }).catch(() => null);
  check('给出截断的系统提示', Boolean(notice), notice?.text ?? '未出现');

  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n通过 ${results.length - failed.length}/${results.length} 项` +
      (failed.length ? `\n未通过：${failed.map((f) => f.name).join('、')}` : '\n全部通过 ✅'),
  );
  return failed.length;
}

let code = 1;
try {
  code = await run();
} catch (err) {
  check(`执行中断：${err.message}`, false);
  code = 1;
}
process.exit(code);
