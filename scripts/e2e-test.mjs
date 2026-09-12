#!/usr/bin/env node
/**
 * AgentHub 端到端自检脚本（不依赖任何外部 AI，用内置 mock 适配器）
 *
 *   node scripts/e2e-test.mjs [--server http://127.0.0.1:8787]
 *
 * 覆盖：健康检查 / 注册登录 / 建房加人 / 消息与 @唤醒 / AI 互相接力与跳数上限 /
 *       停止后不再有迟到回帖 / 共享文件上传下载 / ah CLI 拉取聊天记录 /
 *       暂停恢复 / 多 AI 讨论模式 / 邀请码 / 外部客户端在线状态 / @全体 反馈 / 聊天记录导出。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const SERVER = argValue('server', process.env.AH_SERVER ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
// 服务可能跑在自签 HTTPS 上（start-agenthub.bat --https）：本机地址或显式 AH_INSECURE=1 时跳过证书校验
if (
  /^https:/i.test(SERVER) &&
  (process.env.AH_INSECURE === '1' || /\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(SERVER))
) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = Date.now().toString(36).slice(-4);
const ROOM = `e2e-${RUN}`;

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, pass, detail = '') {
  results.push({ name, pass });
  const tag = pass ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  console.log(`${tag} ${name}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`);
}

async function api(pathname, { method = 'GET', body, token, raw, headers = {} } = {}) {
  const res = await fetch(`${SERVER}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
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

async function fetchMessages(limit = 200) {
  const res = await api(`/api/rooms/${ROOM}/messages?limit=${limit}`, { token: tokens[alice] });
  return res.data.messages;
}

const maxId = (messages) => messages.reduce((acc, m) => Math.max(acc, m.id), 0);

async function waitFor(predicate, { timeoutMs = 20000, intervalMs = 400, label = '条件满足' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(intervalMs);
  }
}

let alice;

/** 自检结束后清掉本轮注册的测试账号与测试房间，避免成员列表里堆一堆空号 */
function cleanupTestArtifacts() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      // 房间用默认模式（e2e-* / UI 验证*，含 WS 回归建的 e2e-live-*），成员只清本轮的
      [path.join(REPO, 'scripts', 'prune-test-members.mjs'), '--pattern', `-${RUN}$`, '--apply'],
      { cwd: REPO, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    child.on('close', () => resolve(out));
  });
}

async function run() {
  console.log(`\n=== AgentHub 端到端自检 ===\n服务：${SERVER}\n房间：${ROOM}\n`);

  /* 1. 健康检查 */
  const health = await api('/api/health');
  check('服务健康检查 /api/health', health.ok && health.data.ok, `Node ${health.data.node}`);
  const mockProbe = health.data.adapters?.find((a) => a.id === 'mock');
  check('适配器探测：mock 可用', Boolean(mockProbe?.available), mockProbe?.detail ?? '');

  /* 2. 注册 / 登录 */
  const suffix = RUN;
  alice = `alice-${suffix}`;
  const a = await register(alice, '阿丽');
  check('注册人类成员并拿到 token', Boolean(tokens[alice]), `tag=${a.tag} role=${a.role}`);
  await register(`codex-${suffix}`, 'Codex 一号', { kind: 'agent', adapterId: 'mock', agentKind: 'codex' });
  await register(`claude-${suffix}`, 'Claude 小助手', { kind: 'agent', adapterId: 'mock', agentKind: 'claude' });
  await register(`loop-${suffix}`, '接力黑洞', { kind: 'agent', adapterId: 'mock-chain', agentKind: 'mock' });
  check('注册 3 个 AI 成员', Object.keys(tokens).length === 4);

  const badLogin = await api('/api/login', {
    method: 'POST',
    body: { tag: alice, token: 'wrong-token' },
  });
  check('错误 token 登录被拒绝', badLogin.status === 401);
  const goodLogin = await api('/api/login', { method: 'POST', body: { tag: alice, token: tokens[alice] } });
  check('正确 token 登录成功', goodLogin.ok && goodLogin.data.member.tag === alice);
  const noAuth = await api('/api/rooms');
  check('未登录访问接口返回 401', noAuth.status === 401);

  /* 3. 建房 + 加人 */
  const room = await api('/api/rooms', {
    method: 'POST',
    token: tokens[alice],
    body: {
      name: ROOM,
      topic: '端到端自检',
      members: [`codex-${suffix}`, `claude-${suffix}`, `loop-${suffix}`],
    },
  });
  check('创建房间并自动加入成员', room.ok && room.data.room.memberCount >= 4, room.data.room?.id);

  /* 4. 人类消息 → @唤醒 AI → AI 之间互相接力 */
  const first = await api(`/api/rooms/${ROOM}/messages`, {
    method: 'POST',
    token: tokens[alice],
    body: { text: `@codex-${suffix} 我们准备做一个人机群聊工具，第一步做什么？` },
  });
  check('发送消息并唤醒 AI（返回排队数 ≥1）', first.ok && first.data.queued >= 1, `queued=${first.data.queued}`);

  const agentReply = await waitFor(async () => {
    const msgs = await fetchMessages();
    return msgs.find((m) => m.senderTag === `codex-${suffix}`);
  }, { label: `等待 @codex-${suffix} 回帖` });
  check('被 @ 的 AI 在群里回帖', Boolean(agentReply), `#${agentReply.id} hop=${agentReply.hop}`);

  const chained = await waitFor(async () => {
    const msgs = await fetchMessages();
    return msgs.find((m) => m.senderTag === `claude-${suffix}`);
  }, { label: '等待 AI 之间接力（Claude 被 Codex 叫到）' });
  check('AI 之间可以互相交流（A 提到 B，B 收到并回应）', Boolean(chained), `#${chained.id} hop=${chained.hop}`);

  /* 5. 接力上限与迟到回帖 */
  await api(`/api/rooms/${ROOM}/messages`, {
    method: 'POST',
    token: tokens[alice],
    body: { text: `@loop-${suffix} 请随便说点什么` },
  });
  const stopped = await waitFor(async () => {
    const msgs = await fetchMessages();
    return msgs.find((m) => m.senderKind === 'system' && m.text.includes('最大接力跳数'));
  }, { timeoutMs: 40000, label: '等待接力跳数上限触发' });
  check('接力跳数上限会中断讨论链', Boolean(stopped), stopped.text.slice(0, 60));

  await sleep(6000);
  const after = await fetchMessages();
  const late = after.filter((m) => m.id > stopped.id && m.senderKind === 'agent' && m.senderTag === `loop-${suffix}`);
  check('链停止后不再有迟到回帖（排队任务被丢弃）', late.length === 0, `迟到 ${late.length} 条`);

  /* 6. 共享文件区 */
  const payload = Buffer.from(`AgentHub e2e 共享文件测试 ${RUN}\n`, 'utf8');
  const upload = await api(`/api/rooms/${ROOM}/files`, {
    method: 'POST',
    token: tokens[alice],
    raw: true,
    body: new Uint8Array(payload),
    headers: {
      'Content-Type': 'text/plain',
      'X-File-Name': encodeURIComponent('e2e-note.txt'),
    },
  });
  check('上传文件到共享文件区', upload.ok, upload.data.file?.id);
  const download = await fetch(`${SERVER}/api/files/${upload.data.file.id}?download=1`, {
    headers: { Authorization: `Bearer ${tokens[alice]}` },
  });
  const roundTrip = Buffer.from(await download.arrayBuffer());
  const sameHash =
    crypto.createHash('sha256').update(roundTrip).digest('hex') ===
    crypto.createHash('sha256').update(payload).digest('hex');
  check('下载文件内容与上传一致（sha256 校验）', download.ok && sameHash);

  /* 7. ah CLI 拉取聊天记录 */
  const cli = await runCli(['history', '--room', ROOM, '--limit', '5'], { AH_TAG: alice, AH_TOKEN: tokens[alice] });
  check('ah CLI 能拉取聊天记录', cli.code === 0 && cli.stdout.includes(ROOM), cli.stdout.split('\n')[0]);
  const cliSend = await runCli(['send', '来自 CLI 的一条消息', '--room', ROOM], {
    AH_TAG: alice,
    AH_TOKEN: tokens[alice],
  });
  check('ah CLI 能发送新消息', cliSend.code === 0 && cliSend.stdout.includes('已发送'));

  /* 8. 暂停 / 恢复 */
  await api(`/api/rooms/${ROOM}/control`, { method: 'POST', token: tokens[alice], body: { action: 'pause' } });
  const beforePause = maxId(await fetchMessages());
  await api(`/api/rooms/${ROOM}/messages`, {
    method: 'POST',
    token: tokens[alice],
    body: { text: `@codex-${suffix} 这条应该没人回` },
  });
  await sleep(4000);
  const duringPause = await fetchMessages();
  check(
    '暂停后 AI 不再自动接力',
    duringPause.filter((m) => m.id > beforePause && m.senderKind === 'agent').length === 0,
  );
  await api(`/api/rooms/${ROOM}/control`, { method: 'POST', token: tokens[alice], body: { action: 'resume' } });
  await api(`/api/rooms/${ROOM}/messages`, {
    method: 'POST',
    token: tokens[alice],
    body: { text: `@claude-${suffix} 恢复后再试一次` },
  });
  const resumed = await waitFor(async () => {
    const msgs = await fetchMessages();
    return msgs.some(
      (m) => m.senderTag === `claude-${suffix}` && m.text.includes('恢复后再试一次'),
    );
  }, { label: '等待恢复后的回帖' });
  check('恢复后 AI 继续参与', Boolean(resumed));

  /* 9. 讨论模式 */
  const discuss = await api(`/api/rooms/${ROOM}/discuss`, {
    method: 'POST',
    token: tokens[alice],
    body: { topic: '怎么设计共享文件区的权限', tags: [`codex-${suffix}`, `claude-${suffix}`], rounds: 1 },
  });
  check('发起多 AI 讨论', discuss.ok);
  const ended = await waitFor(async () => {
    const msgs = await fetchMessages();
    return msgs.find((m) => m.text.includes('讨论结束'));
  }, { timeoutMs: 40000, label: '等待讨论结束' });
  const discussionTurns = (await fetchMessages()).filter((m) => m.meta?.mode === 'discuss').length;
  check('讨论模式产出多轮发言', discussionTurns >= 2, `${discussionTurns} 次发言｜${ended.text}`);

  /* 10. 运行记录 */
  const runs = await api(`/api/agents/codex-${suffix}/runs?limit=5`, { token: tokens[alice] });
  check('可查询 AI 运行记录（含提示词与耗时）', Array.isArray(runs.data.runs), `${runs.data.runs?.length ?? 0} 条`);

  /* 11. @全体 群发 */
  const beforeAll = maxId(await fetchMessages());
  const broadcast = await api(`/api/rooms/${ROOM}/messages`, {
    method: 'POST',
    token: tokens[alice],
    body: { text: '@全体 各位报一下自己负责哪一块，一句话即可。' },
  });
  check('@全体 一次唤醒全体 AI（排队数 = AI 成员数）', broadcast.ok && broadcast.data.queued >= 3, `queued=${broadcast.data.queued}`);
  const replies = await waitFor(async () => {
    const msgs = (await fetchMessages()).filter((m) => m.id > beforeAll && m.senderKind === 'agent');
    const senders = new Set(msgs.map((m) => m.senderTag));
    return senders.size >= 3 ? senders : null;
  }, { timeoutMs: 40000, label: '等待全体 AI 回帖' }).catch(() => null);
  check(
    '全体 AI 都收到了群发消息',
    Boolean(replies && replies.size >= 3),
    replies ? [...replies].map((t) => `@${t}`).join(' ') : '超时未收齐',
  );

  const alias = await api(`/api/rooms/${ROOM}/messages`, {
    method: 'POST',
    token: tokens[alice],
    body: { text: '用中文写法再试一次：@所有人 收到请忽略本条。' },
  });
  check('@所有人 等中文写法同样生效', alias.ok && alias.data.queued >= 3, `queued=${alias.data.queued}`);

  const notAll = await api(`/api/rooms/${ROOM}/messages`, {
    method: 'POST',
    token: tokens[alice],
    body: { text: `这不是群发：@alliance 只是长得像（本房间没有这个成员）` },
  });
  check('@alliance 不会被误判成 @全体', notAll.ok && notAll.data.queued === 0, `queued=${notAll.data.queued}`);

  /* 12. 实时推送回归：连接之后新建的房间也必须能收到推送（不需要刷新） */
  const wsUrl = `${SERVER.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(tokens[alice])}`;
  const socket = new WebSocket(wsUrl);
  const received = [];
  socket.addEventListener('message', (event) => {
    try {
      received.push(JSON.parse(event.data));
    } catch {
      /* 忽略非 JSON */
    }
  });
  await waitFor(() => received.some((e) => e.type === 'hello'), { timeoutMs: 8000, label: 'WebSocket 建立' });
  // 连接建立时 alice 已在若干房间里 —— 这正是历史缺陷的触发条件（快照非空）
  const lateRoomName = `e2e-live-${RUN}`;
  const lateRoom = await api('/api/rooms', {
    method: 'POST',
    token: tokens[alice],
    body: { name: lateRoomName, topic: '实时推送回归' },
  });
  await api(`/api/rooms/${encodeURIComponent(lateRoomName)}/messages`, {
    method: 'POST',
    token: tokens[alice],
    body: { text: '连接之后新建的房间，这条必须实时推送过来' },
  });
  const pushed = await waitFor(
    () =>
      received.find(
        (e) => e.type === 'message' && e.data?.roomId === lateRoom.data.room.id && String(e.data?.text).includes('必须实时推送'),
      ),
    { timeoutMs: 10000, label: '新房间的实时推送' },
  ).catch(() => null);
  check('连接之后新建的房间也能实时收到消息（无需刷新）', Boolean(pushed));
  socket.close();
  await api(`/api/rooms/${encodeURIComponent(lateRoomName)}`, { method: 'DELETE', token: tokens[alice] }).catch(() => {});

  /* 13. 图片附件链路：图片要作为图像输入写进提示词（codex -i / HTTP image_url）*/
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVR42mP8z8DAwMgABIwMDAz/Gf4zMDAAAGZfBgcRZ6W9AAAAAElFTkSuQmCC',
    'base64',
  );
  const pngUpload = await api(`/api/rooms/${ROOM}/files`, {
    method: 'POST',
    token: tokens[alice],
    raw: true,
    body: new Uint8Array(pngBytes),
    headers: { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('e2e-image.png') },
  });
  check('可以上传图片附件', pngUpload.ok, pngUpload.data.file?.id);
  await api(`/api/rooms/${ROOM}/messages`, {
    method: 'POST',
    token: tokens[alice],
    body: {
      text: `@codex-${suffix} 看下这张图，一句话说它是什么颜色`,
      files: [pngUpload.data.file.id],
    },
  });
  const imagePrompt = await waitFor(async () => {
    const res = await api(`/api/agents/codex-${suffix}/runs?limit=3`, { token: tokens[alice] });
    return (res.data.runs ?? []).find((r) => String(r.prompt ?? '').includes('【本次附带图像】'));
  }, { timeoutMs: 25000, label: '等待带图提示词' }).catch(() => null);
  check(
    '图片会作为图像输入写进提示词（codex -i 链路）',
    Boolean(imagePrompt && imagePrompt.prompt.includes('e2e-image.png')),
    imagePrompt ? '提示词含【本次附带图像】' : '未在运行记录里找到',
  );

  /* 14. 邀请码：显示 + 新用户凭码加入 + 权限边界 */
  const roomDetail = await api(`/api/rooms/${ROOM}`, { token: tokens[alice] });
  const roomCode = roomDetail.data.room?.code ?? '';
  check('房间有唯一邀请码', /^[0-9A-Z]{6}$/.test(roomCode), roomCode);

  const newbieTag = `newbie-${suffix}`;
  const newbie = await api('/api/register', {
    method: 'POST',
    body: { tag: newbieTag, nickname: '新同学' },
  });
  const beforeJoin = await api('/api/rooms', { token: newbie.data.token });
  check('新用户初始没有任何房间', (beforeJoin.data.rooms ?? []).length === 0);

  // 故意用小写 + 短横线，验证归一化
  const joinedRoom = await api('/api/rooms/join', {
    method: 'POST',
    token: newbie.data.token,
    body: { code: `${roomCode.slice(0, 3)}-${roomCode.slice(3)}`.toLowerCase() },
  });
  check(
    '新用户凭邀请码加入群聊（大小写/短横线不敏感）',
    joinedRoom.ok && joinedRoom.data.room?.id === roomDetail.data.room.id,
    joinedRoom.data.room?.name ?? joinedRoom.data.error,
  );

  const afterJoin = await api('/api/rooms', { token: newbie.data.token });
  check('加入后能在自己的房间列表里看到它', (afterJoin.data.rooms ?? []).length === 1);

  const readable = await api(`/api/rooms/${ROOM}/messages?limit=3`, { token: newbie.data.token });
  check('加入后可以读取该群消息', readable.ok && Array.isArray(readable.data.messages));

  const badCode = await api('/api/rooms/join', {
    method: 'POST',
    token: newbie.data.token,
    body: { code: 'ZZZZZZ' },
  });
  check('无效邀请码返回 404 且有可读提示', badCode.status === 404, badCode.data.error ?? '');

  const rotateByOther = await api(`/api/rooms/${ROOM}/code/rotate`, {
    method: 'POST',
    token: newbie.data.token,
  });
  check('非群主不能重置邀请码（403）', rotateByOther.status === 403);

  const rotated = await api(`/api/rooms/${ROOM}/code/rotate`, {
    method: 'POST',
    token: tokens[alice],
  });
  const oldCodeGone = await api('/api/rooms/join', {
    method: 'POST',
    token: newbie.data.token,
    body: { code: roomCode },
  });
  check(
    '群主重置后旧码失效、新码可用',
    rotated.ok && rotated.data.code !== roomCode && oldCodeGone.status === 404,
    `${roomCode} → ${rotated.data.code}`,
  );

  /* 14. 外部客户端（adapter=external）的在线状态：没有长连接，按「最近有没有带 token 活动」判定 */
  const extTag = `ext-${suffix}`;
  await register(extTag, '外部 AI', { kind: 'agent', adapterId: 'external' });
  await api(`/api/rooms/${ROOM}/members`, { method: 'POST', token: tokens[alice], body: { tag: extTag } });
  const roomBefore = await api(`/api/rooms/${ROOM}`, { token: tokens[alice] });
  const extBefore = roomBefore.data.members?.find((m) => m.tag === extTag);
  check(
    '外部客户端成员被标记 external，且从没活跃过时显示离线',
    extBefore?.external === true && extBefore?.online === false,
  );

  await api('/api/me', { token: tokens[extTag] });
  const roomAfter = await api(`/api/rooms/${ROOM}`, { token: tokens[alice] });
  const extAfter = roomAfter.data.members?.find((m) => m.tag === extTag);
  check(
    '外部客户端拉过一次消息后显示在线（带 lastSeenAt）',
    extAfter?.online === true && Boolean(extAfter?.lastSeenAt),
  );

  /* 15. @全体 的可见反馈：说清入队了几个、哪些外部客户端要自己拉 */
  await api(`/api/rooms/${ROOM}/messages`, {
    method: 'POST',
    token: tokens[alice],
    body: { text: '@全体 汇报一下现在的状态' },
  });
  const noticeMsgs = await fetchMessages(40);
  const broadcastNotice = noticeMsgs.find(
    (m) => m.type === 'system' && m.text.includes('@全体') && m.text.includes('外部客户端'),
  );
  check(
    '@全体 会给出「通知了谁」的系统反馈（含外部客户端要自己拉）',
    Boolean(broadcastNotice) && /已通知 \d+ 个/.test(broadcastNotice.text),
    broadcastNotice?.text ?? '(没有找到反馈消息)',
  );

  /* 16. 聊天记录导出 */
  const exportMd = await api(`/api/rooms/${ROOM}/export?format=md&token=${encodeURIComponent(tokens[alice])}`);
  const mdText = String(exportMd.data.raw ?? '');
  check(
    '导出 Markdown：带房名与正文',
    exportMd.status === 200 && mdText.startsWith(`# ${ROOM}`) && mdText.includes('汇报一下现在的状态'),
    `${mdText.length} 字符`,
  );

  const exportJson = await api(`/api/rooms/${ROOM}/export?format=json&token=${encodeURIComponent(tokens[alice])}`);
  const jsonCount = exportJson.data?.count;
  check(
    '导出 JSON：可解析且条数吻合',
    exportJson.status === 200 && Number.isFinite(jsonCount) && jsonCount > 0,
    `count=${jsonCount}`,
  );

  const exportFiltered = await api(
    `/api/rooms/${ROOM}/export?format=md&search=${encodeURIComponent('汇报一下')}&token=${encodeURIComponent(tokens[alice])}`,
  );
  check('导出支持按关键词过滤', String(exportFiltered.data.raw ?? '').includes('汇报一下现在的状态'));

  const exportBad = await api(`/api/rooms/${ROOM}/export?format=csv&token=${encodeURIComponent(tokens[alice])}`);
  check('导出格式非法返回 400', exportBad.status === 400);

  const exportAnon = await api(`/api/rooms/${ROOM}/export?format=md`);
  check('未登录不能导出聊天记录（401）', exportAnon.status === 401);
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, 'server', 'bin', 'ah.mjs'), ...args], {
      env: { ...process.env, AH_SERVER: SERVER, NO_COLOR: '1', ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

try {
  await run();
} catch (err) {
  check(`执行中断：${err.message}`, false);
} finally {
  const cleanupLog = await cleanupTestArtifacts().catch(() => '');
  if (cleanupLog) {
    const line = cleanupLog.split(/\r?\n/).find((l) => l.includes('已删除'));
    if (line) console.log(`\n${line.trim()}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n通过 ${results.length - failed.length}/${results.length} 项` +
      (failed.length ? `\n未通过：${failed.map((f) => f.name).join('、')}` : '\n全部通过 ✅'),
  );
  if (failed.length) {
    console.log(`\n房间 ${ROOM} 的完整记录：ah history --room ${ROOM}`);
  }
  process.exit(failed.length ? 1 : 0);
}
