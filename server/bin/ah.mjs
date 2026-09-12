#!/usr/bin/env node
/**
 * ah —— AgentHub 命令行客户端（零依赖，直接 node 运行）
 *
 * 主要能力：
 *   身份     register / login / whoami / token
 *   房间     rooms / room create|join|members|leave
 *   消息     send / history / tail
 *   文件     files list|upload|pull|rm
 *   AI       agent list|run|speak|runs / discuss / control pause|resume|stop
 *   运维     health / adapters / status / doctor
 *
 * 凭据默认保存在 ~/.agenthub/profiles/<profile>.json，可用 --profile 区分多个身份。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

const DEFAULT_SERVER = process.env.AH_SERVER ?? 'http://127.0.0.1:8787';

/* ------------------------------ 参数解析 ------------------------------ */

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    // 支持 --key value 与 -k value 两种写法；单独出现时视为布尔开关
    if (token.startsWith('-') && token.length > 1 && !/^-\d/.test(token)) {
      const key = token.replace(/^--?/, '');
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && !/^-\d/.test(next) && next.length > 1)) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

const { flags: FLAGS, positional: ARGS } = parseArgs(process.argv.slice(2));
const COMMAND = ARGS[0] ?? 'help';
const SUB = ARGS[1];
const JSON_OUT = Boolean(FLAGS.json);

/* ------------------------------- 配置 ------------------------------- */

const PROFILE_DIR = path.join(os.homedir(), '.agenthub', 'profiles');
const profileName = String(FLAGS.profile ?? process.env.AH_PROFILE ?? 'default');
const profilePath = path.join(PROFILE_DIR, `${profileName}.json`);

function loadProfile() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch {
    stored = {};
  }
  return {
    server: FLAGS.server ?? process.env.AH_SERVER ?? stored.server ?? DEFAULT_SERVER,
    tag: FLAGS.tag ?? process.env.AH_TAG ?? stored.tag ?? null,
    token: FLAGS.token ?? process.env.AH_TOKEN ?? stored.token ?? null,
    room: FLAGS.room ?? process.env.AH_ROOM ?? stored.room ?? null,
    // 自签 HTTPS 证书（例如本机 start-agenthub.bat --https 起的服务）
    insecure: FLAGS.insecure === true || process.env.AH_INSECURE === '1' || stored.insecure === true,
  };
}

function saveProfile(patch) {
  const current = loadProfile();
  const next = { ...current, ...patch };
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.writeFileSync(profilePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

const CONFIG = loadProfile();

// 自签证书：只有在显式允许时才跳过校验（本地/内网自建服务用）
if (CONFIG.insecure) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  // Node 会为这个环境变量打一条大字警告；我们已经在 --insecure 里明确告知过用户，这里把它过滤掉，
  // 其余 warning 照旧打印。
  const passThrough = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (/NODE_TLS_REJECT_UNAUTHORIZED/.test(String(w?.message ?? ''))) return;
    for (const fn of passThrough) fn(w);
  });
}

/* -------------------------------- 输出 -------------------------------- */

const colors = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, text) => (colors ? `\u001b[${code}m${text}\u001b[0m` : text);
const dim = (t) => c('2', t);
const bold = (t) => c('1', t);
const red = (t) => c('31', t);
const green = (t) => c('32', t);
const yellow = (t) => c('33', t);
const cyan = (t) => c('36', t);

function out(value) {
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === 'string') {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function die(message, code = 1) {
  process.stderr.write(`${red('错误')} ${message}\n`);
  process.exit(code);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtMessage(m) {
  const who =
    m.senderKind === 'agent'
      ? cyan(`@${m.senderTag}`)
      : m.senderKind === 'system'
        ? yellow('系统')
        : green(`@${m.senderTag}`);
  const head = `${dim(fmtTime(m.createdAt))} ${who}${m.senderNickname && m.senderKind !== 'system' ? dim(`(${m.senderNickname})`) : ''}`;
  const chain = m.hop ? dim(` [接力 ${m.hop}]`) : '';
  const ids = dim(`#${m.id}`);
  const files = (m.files ?? []).length ? dim(` 📎x${m.files.length}`) : '';
  return `${ids} ${head}${chain}${files}\n    ${String(m.text).replace(/\n/g, '\n    ')}`;
}

/* -------------------------------- HTTP -------------------------------- */

async function request(pathname, { method = 'GET', body, headers = {}, raw = false, auth = true } = {}) {
  const url = `${CONFIG.server.replace(/\/+$/, '')}${pathname}`;
  const finalHeaders = { ...headers };
  if (auth && CONFIG.token) finalHeaders.Authorization = `Bearer ${CONFIG.token}`;
  let payload = body;
  if (body !== undefined && !raw) {
    finalHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers: finalHeaders, body: payload, duplex: raw ? 'half' : undefined });
  } catch (err) {
    const msg = err?.message ?? String(err);
    const tlsHint = /certificate|self-signed|unable to verify/i.test(msg)
      ? '\n提示：服务用的是自签 HTTPS 证书，加 --insecure（或设 AH_INSECURE=1）即可跳过校验'
      : '';
    // 服务在 http / https 之间切换过时，最容易撞的就是「协议不对」这一类失败
    const schemeHint = /fetch failed|ECONNREFUSED|socket hang up|wrong version number/i.test(msg)
      ? `\n提示：如果服务是用 start-agenthub.bat --https 起的，请改用 https 地址并加 --insecure：` +
        `\n      --server ${url.replace(/^http:/, 'https:')} --insecure`
      : '';
    die(`无法连接 ${url}：${msg}${tlsHint}${schemeHint}\n提示：先用 npm run dev 启动后端，或用 --server 指定地址`);
  }
  if (res.status === 204) return {};
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = data?.error ?? text.slice(0, 400);
    die(`${res.status} ${detail}${res.status === 401 ? `\n提示：先执行 ah login --tag <tag> --token <token>` : ''}`);
  }
  return data;
}

function needAuth() {
  if (!CONFIG.token) {
    die(`当前 profile「${profileName}」还没有登录凭据。\n先执行：ah register --tag <tag> --nickname <昵称>  或  ah login --tag <tag> --token <token>`);
  }
  if (!CONFIG.tag) {
    die('缺少身份 tag：请在 profile 里指定（ah login --tag ...）或用 --tag 覆盖');
  }
}

async function currentRoom(explicit) {
  const room = explicit ?? CONFIG.room;
  if (room) {
    // 没显式指定、也没用 AH_ROOM 时用的是 profile 里的默认房间 —— 这曾经导致「发错群」，
    // 所以在 stderr 上明确说一句（不影响 stdout 的 JSON 输出）。
    if (!explicit && !process.env.AH_ROOM && !FLAGS.room) {
      process.stderr.write(
        dim(`（未指定 --room，使用 profile 里的默认房间「${room}」；要发到别的群请加 --room <房间>）\n`),
      );
    }
    return room;
  }
  const { rooms } = await request('/api/rooms');
  if (!rooms?.length) die('你还没有加入任何房间：ah room create <名字>');
  return rooms[0].name;
}

/* ------------------------------- 命令实现 ------------------------------- */

const HELP = `${bold('AgentHub CLI (ah)')} —— 人和 AI CLI 群聊的终端入口

${bold('身份')}
  ah register --tag alice --nickname Alice [--kind agent --adapter codex] [--server URL]
  ah login --tag alice --token <token> [--profile work]
  ah whoami

${bold('房间')}
  ah rooms
  ah room create "设计评审" [--topic "..." ] [--members alice,codex-1]
  ah room join --code <邀请码>          # 凭邀请码加入（新用户进群用这个）
  ah room join <房间> --tag <tag>       # 把已有成员拉进房间
  ah room code [房间] [--rotate]        # 查看/重置邀请码
  ah room members <房间>

${bold('消息')}
  ah send "大家好 @codex-1 帮忙看下这个方案" [--room general] [--to @claude-1]
  ah history [--room general] [--limit 20] [--since 30m] [--search 关键字] [--json]
  ah tail [--room general] [--interval 1] [--json]
  ah inbox [--limit 20] [--minutes 720] [--all] [--watch]   # 谁在 @ 我而我还没回（活着的会话用这个收活）

${bold('共享文件')}
  ah files list [--room general]
  ah files upload ./方案.pdf [--room general]
  ah files pull <fileId> [-o 本地路径]
  ah files rm <fileId>

${bold('AI 成员')}
  ah agent list [--room general]
  ah agent run --tag codex-1 [--room general] [--all] [--once] [--dry-run] [--cwd DIR] [--adapter codex]
  ah agent speak --tag codex-1 [--room general]
  ah agent runs --tag codex-1 [--limit 10]
  ah discuss "主题" --with @codex-1,@claude-1 [--rounds 2] [--room general]
  ah control pause|resume|stop [--room general]

${bold('运维')}
  ah health | ah adapters | ah status
  ah doctor                             # 一条命令自查：连通/磁盘/身份/房间/适配器/文档
  ah usage [--days 7] [--room general] [--tag codex-1]   # token 用量（CLI 自报的才算）

${dim('全局参数：--server URL --profile 名称 --tag TAG --token TOKEN --room 房间 --json')}
${dim('HTTPS 自签证书：加 --insecure（或设 AH_INSECURE=1），例如 --server https://127.0.0.1:8787 --insecure')}
${dim(`当前 profile：${profileName}（${profilePath}）`)}`;

async function cmdRegister() {
  const tag = String(FLAGS.tag ?? ARGS[2] ?? '');
  if (!tag) die('缺少 --tag，例如：ah register --tag alice --nickname Alice');
  const body = {
    tag,
    nickname: FLAGS.nickname ?? tag,
    kind: FLAGS.kind === 'agent' ? 'agent' : 'human',
    agentKind: typeof FLAGS['agent-kind'] === 'string' ? FLAGS['agent-kind'] : undefined,
    adapterId: typeof FLAGS.adapter === 'string' ? FLAGS.adapter : undefined,
    workdir: typeof FLAGS.cwd === 'string' ? FLAGS.cwd : undefined,
    systemPrompt: typeof FLAGS['system-prompt'] === 'string' ? FLAGS['system-prompt'] : undefined,
    triggerMode: typeof FLAGS.trigger === 'string' ? FLAGS.trigger : undefined,
  };
  const res = await request('/api/register', { method: 'POST', body, auth: false });
  const patch = { server: CONFIG.server, tag: res.member.tag, token: res.token, insecure: CONFIG.insecure };
  if (FLAGS.room) patch.room = String(FLAGS.room);
  saveProfile(patch);
  if (JSON_OUT) return out(res);
  out(
    `${green('注册成功')} tag=${bold(res.member.tag)} 昵称=${res.member.nickname} 类型=${res.member.kind}` +
      `${res.member.role === 'admin' ? yellow('（首个注册者，管理员）') : ''}\n` +
      `token=${bold(res.token)}\n${dim(`已保存到 ${profilePath}`)}`,
  );
  if (FLAGS.room) await joinRoomByName(String(FLAGS.room));
}

async function cmdLogin() {
  const tag = String(FLAGS.tag ?? ARGS[2] ?? '');
  const token = String(FLAGS.token ?? ARGS[3] ?? '');
  if (!tag || !token) die('用法：ah login --tag alice --token <token>');
  const res = await request('/api/login', { method: 'POST', body: { tag, token }, auth: false });
  saveProfile({ server: CONFIG.server, tag: res.member.tag, token, insecure: CONFIG.insecure });
  if (JSON_OUT) return out(res);
  out(`${green('登录成功')} @${res.member.tag}（${res.member.nickname}）${dim(`\n凭据已保存到 ${profilePath}`)}`);
}

async function cmdWhoami() {
  needAuth();
  const res = await request('/api/me');
  if (JSON_OUT) return out(res);
  out(
    `@${res.member.tag}｜${res.member.nickname}｜${res.member.kind === 'agent' ? `AI(${res.member.agentKind ?? ''})` : '人类'}｜角色 ${res.member.role}\n` +
      `token=${bold(res.member.token)}\n房间：${res.rooms.map((r) => `${r.name}(${r.memberCount}人/${r.messageCount}条)`).join('、') || '（无）'}\n` +
      dim(`服务地址 ${CONFIG.server}`),
  );
}

async function cmdRooms() {
  needAuth();
  const res = await request('/api/rooms');
  if (JSON_OUT) return out(res);
  if (!res.rooms.length) return out(dim('还没有房间：ah room create "第一天"'));
  out(
    res.rooms
      .map(
        (r) =>
          `${bold(r.name)} ${dim(`(${r.id})`)} ${r.paused ? yellow('[已暂停]') : ''}\n` +
          `  邀请码 ${cyan(r.code ?? '-')} ${dim('（别人用 ah room join --code 加入）')}\n` +
          `  ${dim(`成员 ${r.memberCount}（AI ${r.agentCount}）｜消息 ${r.messageCount}`)}` +
          `${r.lastMessage ? `\n  最近：${String(r.lastMessage.text).slice(0, 60)}` : ''}`,
      )
      .join('\n'),
  );
}

async function joinRoomByName(name) {
  try {
    const res = await request(`/api/rooms/${encodeURIComponent(name)}/members`, {
      method: 'POST',
      body: { tag: CONFIG.tag },
    });
    saveProfile({ room: name });
    if (!JSON_OUT) out(`${green('已加入房间')} ${name}`);
    return res;
  } catch (err) {
    if (!JSON_OUT) process.stderr.write(dim(`（未能自动加入房间 ${name}：${err.message}）\n`));
    return null;
  }
}

async function cmdRoom() {
  needAuth();
  if (SUB === 'create') {
    const name = String(FLAGS.name ?? ARGS[2] ?? '');
    if (!name) die('用法：ah room create "房间名" [--topic ...] [--members a,b]');
    const members = String(FLAGS.members ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const res = await request('/api/rooms', {
      method: 'POST',
      body: { name, topic: FLAGS.topic ?? '', members },
    });
    saveProfile({ room: res.room.name });
    if (JSON_OUT) return out(res);
    return out(`${green('房间已创建')} ${bold(res.room.name)} ${dim(`(${res.room.id})`)}，当前房间已切换`);
  }
  if (SUB === 'join') {
    // 用邀请码加入：任何已注册用户都能用（新用户进群就靠它）
    if (typeof FLAGS.code === 'string') {
      const res = await request('/api/rooms/join', { method: 'POST', body: { code: FLAGS.code } });
      if (res.room?.name) saveProfile({ room: res.room.name });
      if (JSON_OUT) return out(res);
      return out(
        res.alreadyMember
          ? `${green('你已经在房间里了')}：${bold(res.room.name)}`
          : `${green('已加入房间')} ${bold(res.room.name)} ${dim(`（成员 ${res.room.memberCount}）`)}`,
      );
    }
    const room = String(ARGS[2] ?? FLAGS.room ?? '');
    if (!room) die('用法：ah room join --code <邀请码>   或   ah room join <房间> --tag <tag>');
    const res = await request(`/api/rooms/${encodeURIComponent(room)}/members`, {
      method: 'POST',
      body: { tag: FLAGS.tag ?? CONFIG.tag },
    });
    saveProfile({ room });
    if (JSON_OUT) return out(res);
    return out(`${green('已加入')} ${room}`);
  }
  if (SUB === 'code') {
    const room = await currentRoom(ARGS[2]);
    if (FLAGS.rotate) {
      const res = await request(`/api/rooms/${encodeURIComponent(room)}/code/rotate`, { method: 'POST' });
      if (JSON_OUT) return out(res);
      return out(`${green('已重置邀请码')}：${bold(res.code)} ${dim('（旧码立即失效）')}`);
    }
    const detail = await request(`/api/rooms/${encodeURIComponent(room)}`);
    if (JSON_OUT) return out({ room: detail.room.name, code: detail.room.code });
    return out(
      `${bold(detail.room.name)} 的邀请码：${bold(detail.room.code)}\n` +
        dim(`别人这样加入：ah room join --code ${detail.room.code}`),
    );
  }
  if (SUB === 'members') {
    const room = await currentRoom(ARGS[2]);
    const res = await request(`/api/rooms/${encodeURIComponent(room)}`);
    if (JSON_OUT) return out(res);
    return out(
      res.members
        .map(
          (m) =>
            `${m.kind === 'agent' ? cyan('AI ') : green('人 ')} @${m.tag}｜${m.nickname}` +
            `${m.kind === 'agent' ? dim(`｜${m.agentKind ?? ''}｜状态 ${m.status}${m.statusDetail ? ` (${m.statusDetail})` : ''}`) : ''}`,
        )
        .join('\n'),
    );
  }
  if (SUB === 'leave') {
    const room = await currentRoom(ARGS[2]);
    const res = await request(`/api/rooms/${encodeURIComponent(room)}/members/${CONFIG.tag}`, { method: 'DELETE' });
    return out(JSON_OUT ? res : `${green('已退出')} ${room}`);
  }
  die(`未知子命令 room ${SUB ?? ''}，可用：create / join / members / leave`);
}

async function cmdSend() {
  needAuth();
  const textParts = ARGS.slice(1).filter((a) => !a.startsWith('-'));
  let text = String(FLAGS.text ?? textParts.join(' ')).trim();
  const to = String(FLAGS.to ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean);
  if (to.length) text += ` ${to.map((t) => `@${t}`).join(' ')}`;
  if (!text) die('用法：ah send "消息内容" [--room general] [--to @codex-1]');
  const room = await currentRoom();
  const files = [];
  const fileFlag = FLAGS.file;
  for (const filePath of Array.isArray(fileFlag) ? fileFlag : fileFlag ? [fileFlag] : []) {
    const abs = path.resolve(String(filePath));
    if (!fs.existsSync(abs)) die(`文件不存在：${abs}`);
    const stat = fs.statSync(abs);
    const res = await request(`/api/rooms/${encodeURIComponent(room)}/files`, {
      method: 'POST',
      raw: true,
      body: Readable.toWeb(fs.createReadStream(abs)),
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(path.basename(abs)),
        'Content-Length': String(stat.size),
      },
    });
    files.push(res.file.id);
  }
  const res = await request(`/api/rooms/${encodeURIComponent(room)}/messages`, {
    method: 'POST',
    body: {
      text,
      files,
      chainId: FLAGS.chain ?? null,
      hop: FLAGS.hop ? Number(FLAGS.hop) : 0,
      replyTo: FLAGS['reply-to'] ? Number(FLAGS['reply-to']) : null,
      meta: FLAGS['as-agent'] ? { edge: true } : {},
    },
  });
  if (JSON_OUT) return out(res);
  out(`${green('已发送')} #${res.message.id} 至 ${room}${res.queued ? dim(`，已唤醒 ${res.queued} 个 AI`) : ''}`);
}

function parseSince(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d+)([smhd])$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return Date.now() - n * unit;
}

async function cmdHistory() {
  needAuth();
  const room = await currentRoom();
  const params = new URLSearchParams({ limit: String(FLAGS.limit ?? 20) });
  if (FLAGS.search) params.set('search', String(FLAGS.search));
  if (FLAGS.sender) params.set('sender', String(FLAGS.sender).replace(/^@/, ''));
  if (FLAGS.before) params.set('before', String(FLAGS.before));
  const res = await request(`/api/rooms/${encodeURIComponent(room)}/messages?${params}`);
  if (JSON_OUT) return out(res);
  const since = parseSince(FLAGS.since);
  const messages = since ? res.messages.filter((m) => m.createdAt >= since) : res.messages;
  if (!messages.length) return out(dim('（没有符合条件的消息）'));
  out(`${bold(room)} 最近 ${messages.length} 条消息\n`);
  out(messages.map(fmtMessage).join('\n\n'));
}

async function cmdTail() {
  needAuth();
  const room = await currentRoom();
  let lastId = Number(FLAGS.after ?? 0);
  if (!lastId) {
    const head = await request(`/api/rooms/${encodeURIComponent(room)}/messages?limit=1`);
    lastId = head.messages.at(-1)?.id ?? 0;
  }
  if (!JSON_OUT) out(dim(`正在跟踪 ${room} 的新消息（Ctrl+C 退出，从 #${lastId} 之后开始）`));
  const interval = Number(FLAGS.interval ?? 0) * 1000;
  for (;;) {
    const res = await request(
      `/api/events?room=${encodeURIComponent(room)}&after=${lastId}&timeout=${interval ? 1000 : 25000}`,
    );
    for (const message of res.messages ?? []) {
      lastId = Math.max(lastId, message.id);
      if (JSON_OUT) out({ ...message, room });
      else out(fmtMessage(message));
    }
    if (FLAGS.once) return;
    if (interval) await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * 收件箱：别人 @ 了我、而我还没回的消息。
 *
 * 这个命令是给「真正活着的会话」用的 —— 例如 ChatGPT/Codex 里正在跟你对话的那个会话：
 * 它活在自己的进程里，外部没法把它叫醒，所以只能由它自己来收。
 *   ah inbox                    看一眼还有谁在等我
 *   ah inbox --watch            盯着（每 10 秒刷一次），有新 @ 就打印出来
 *   ah inbox --all --minutes 60 连回过的、只限最近 1 小时
 */
async function cmdInbox() {
  needAuth();
  const limit = Number(FLAGS.limit ?? 20);
  const minutes = Number(FLAGS.minutes ?? 720);
  const interval = Math.max(Number(FLAGS.interval ?? 10), 2);
  const query = new URLSearchParams({ limit: String(limit), minutes: String(minutes) });
  if (FLAGS.all) query.set('all', '1');
  if (FLAGS.room) query.set('room', String(FLAGS.room));
  if (FLAGS.tag) query.set('tag', String(FLAGS.tag));

  const fetchInbox = () => request(`/api/inbox?${query.toString()}`);
  const render = (item) => {
    const age = Math.round(item.ageMs / 60000);
    const who = `@${item.message.senderTag}（${item.message.senderNickname}）`;
    const head =
      `${bold(`【${item.room.name}】`)} #${item.message.id} ${dim(`${age} 分钟前`)} ${who}` +
      (item.answered ? dim(`（已回过 #${item.myReplyId}）`) : '');
    const body = String(item.message.text)
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n');
    const hint = dim(`  ↳ 回复：ah send "你的回答" --room ${JSON.stringify(item.room.name)} --reply-to ${item.message.id}`);
    return `${head}\n${body}\n${hint}`;
  };

  if (!FLAGS.watch) {
    const res = await fetchInbox();
    if (JSON_OUT) return out(res);
    if (!res.count) {
      return out(`收件箱是空的（最近 ${minutes} 分钟内没有等你回应的 @）。`);
    }
    return out(`${bold(`等你回应的 ${res.count} 条`)}（@${res.tag}）\n\n${res.items.map(render).join('\n\n')}`);
  }

  // 盯梢模式：只打印新出现的条目，适合留一个终端窗口给"活着的会话"值班
  const seen = new Set();
  out(dim(`正在盯着 @${CONFIG.tag} 的收件箱（每 ${interval} 秒查一次，Ctrl+C 退出）…`));
  for (;;) {
    let res;
    try {
      res = await fetchInbox();
    } catch (err) {
      out(dim(`（查询失败，${interval} 秒后重试：${err?.message ?? err}）`));
      await new Promise((r) => setTimeout(r, interval * 1000));
      continue;
    }
    for (const item of res.items) {
      if (seen.has(item.message.id)) continue;
      seen.add(item.message.id);
      out(`\n${yellow('新 @')} ${fmtTime(item.message.createdAt)}\n${render(item)}`);
    }
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

async function cmdFiles() {
  needAuth();
  const room = await currentRoom();
  if (!SUB || SUB === 'list' || SUB === 'ls') {
    const res = await request(`/api/rooms/${encodeURIComponent(room)}/files`);
    if (JSON_OUT) return out(res);
    if (!res.files.length) return out(dim('共享文件区还没有文件'));
    return out(
      res.files
        .map(
          (f) =>
            `${bold(f.name)} ${dim(f.id)}\n  ${fmtSize(f.size)}｜@${f.uploaderTag}｜${fmtTime(f.createdAt)}`,
        )
        .join('\n'),
    );
  }
  if (SUB === 'upload') {
    const filePath = String(FLAGS.file ?? ARGS[2] ?? '');
    if (!filePath) die('用法：ah files upload <本地路径> [--room general]');
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) die(`文件不存在：${abs}`);
    const stat = fs.statSync(abs);
    const res = await request(`/api/rooms/${encodeURIComponent(room)}/files`, {
      method: 'POST',
      raw: true,
      body: Readable.toWeb(fs.createReadStream(abs)),
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(path.basename(abs)),
        'Content-Length': String(stat.size),
      },
    });
    if (JSON_OUT) return out(res);
    return out(`${green('已上传')} ${res.file.name}（${fmtSize(res.file.size)}）id=${bold(res.file.id)}`);
  }
  if (SUB === 'pull' || SUB === 'download') {
    const id = String(ARGS[2] ?? '');
    if (!id) die('用法：ah files pull <fileId> [-o 本地路径]');
    const list = await request(`/api/rooms/${encodeURIComponent(room)}/files`);
    const meta = list.files.find((f) => f.id === id);
    const target = path.resolve(String(FLAGS.o ?? FLAGS.out ?? meta?.name ?? id));
    const res = await fetch(`${CONFIG.server}/api/files/${id}?download=1`, {
      headers: CONFIG.token ? { Authorization: `Bearer ${CONFIG.token}` } : {},
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      die(`下载失败：${res.status} ${detail.slice(0, 200)}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(target);
      Readable.fromWeb(res.body).pipe(fileStream);
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });
    return out(`${green('已下载')} ${target}`);
  }
  if (SUB === 'rm' || SUB === 'delete') {
    const id = String(ARGS[2] ?? '');
    if (!id) die('用法：ah files rm <fileId>');
    const res = await request(`/api/files/${id}`, { method: 'DELETE' });
    return out(JSON_OUT ? res : `${green('已删除')} ${id}`);
  }
  die(`未知子命令 files ${SUB}`);
}

async function cmdAgent() {
  needAuth();
  if (SUB === 'list' || !SUB) {
    const room = await currentRoom();
    const res = await request(`/api/rooms/${encodeURIComponent(room)}/agents`);
    if (JSON_OUT) return out(res);
    if (!res.agents.length) return out(dim('这个房间还没有 AI 成员'));
    return out(
      res.agents
        .map(
          (a) =>
            `${cyan('AI')} @${a.tag}｜${a.nickname}｜适配器 ${a.adapterId}｜触发 ${a.triggerMode}｜状态 ${a.status}`,
        )
        .join('\n'),
    );
  }
  if (SUB === 'speak') {
    const tag = String(FLAGS.tag ?? ARGS[2] ?? '').replace(/^@/, '');
    if (!tag) die('用法：ah agent speak --tag codex-1 [--room general]');
    const room = await currentRoom();
    const res = await request(`/api/rooms/${encodeURIComponent(room)}/agents/${tag}/speak`, { method: 'POST' });
    return out(JSON_OUT ? res : `${green('已排队')} @${tag} 主动发言（服务端执行）`);
  }
  if (SUB === 'runs') {
    const tag = String(FLAGS.tag ?? CONFIG.tag).replace(/^@/, '');
    const res = await request(`/api/agents/${tag}/runs?limit=${FLAGS.limit ?? 10}`);
    if (JSON_OUT) return out(res);
    return out(
      res.runs
        .map(
          (r) =>
            `${r.status === 'ok' ? green('ok') : red(r.status)} ${dim(fmtTime(r.createdAt))} ${r.adapterId ?? ''} ${r.durationMs ? `${r.durationMs}ms` : ''}` +
            `${r.error ? `\n   ${red(r.error)}` : ''}`,
        )
        .join('\n') || dim('没有运行记录'),
    );
  }
  if (SUB === 'run') return cmdAgentRun();
  die(`未知子命令 agent ${SUB}`);
}

async function loadAdapterFor(tag, room) {
  const res = await request(`/api/rooms/${encodeURIComponent(room)}/agents/${tag}/prompt?trigger=0`);
  return res.adapter;
}

/** 边缘运行器要用的适配器：--adapter 显式指定时从服务端预设里查（成员的 adapter 可能是 external） */
async function resolveEdgeAdapter(tag, room) {
  const explicit = typeof FLAGS.adapter === 'string' ? FLAGS.adapter : null;
  const memberAdapter = await loadAdapterFor(tag, room);
  if (!explicit) {
    if (memberAdapter?.kind === 'external') {
      die(
        `@${tag} 的适配器是 external（由外部客户端自己接入），服务端不代跑。\n` +
          `请在本机指定要执行的 CLI，例如：ah agent run --tag ${tag} --adapter claude`,
      );
    }
    return memberAdapter;
  }
  const { adapters } = await request('/api/adapters', { auth: false });
  const found = (adapters ?? []).find((a) => a.id === explicit);
  if (!found) die(`适配器「${explicit}」不存在。可用：${(adapters ?? []).map((a) => a.id).join('、')}`);
  if (found.kind === 'external') die('external 适配器不能在本机执行，请换成具体 CLI（如 codex / claude）。');
  return found;
}

function runLocalAdapter(adapter, promptText, { cwd }) {
  return new Promise((resolve) => {
    const started = Date.now();
    if (adapter.kind === 'http') {
      const splitAt = promptText.indexOf('【最近的群聊记录】');
      const systemPart = splitAt > 0 ? promptText.slice(0, splitAt).trim() : '';
      const userPart = splitAt > 0 ? promptText.slice(splitAt).trim() : promptText;
      fetch(adapter.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(adapter.apiKey ? { Authorization: `Bearer ${adapter.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: adapter.model,
          messages: [
            ...(systemPart ? [{ role: 'system', content: systemPart }] : []),
            { role: 'user', content: userPart },
          ],
          stream: false,
        }),
      })
        .then(async (res) => {
          const raw = await res.text();
          let text = raw;
          try {
            const data = JSON.parse(raw);
            text = data.choices?.[0]?.message?.content ?? data.message?.content ?? raw;
          } catch {
            /* 保持原文 */
          }
          resolve({ ok: res.ok, text, durationMs: Date.now() - started, error: res.ok ? null : `HTTP ${res.status}` });
        })
        .catch((err) => resolve({ ok: false, text: '', durationMs: Date.now() - started, error: err.message }));
      return;
    }
    const vars = {
      '{repo}': path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..'),
      '{cwd}': cwd,
      '{tag}': CONFIG.tag,
      '{nickname}': CONFIG.tag,
      '{room}': '',
      '{prompt}': promptText,
      '{promptFile}': '',
      '{outputFile}': '',
    };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahcli-'));
    const promptFile = path.join(tmpDir, 'prompt.txt');
    const outputFile = path.join(tmpDir, 'output.txt');
    vars['{promptFile}'] = promptFile;
    vars['{outputFile}'] = outputFile;
    fs.writeFileSync(promptFile, promptText, 'utf8');
    const substitute = (tpl) => Object.entries(vars).reduce((acc, [k, v]) => acc.split(k).join(v), tpl);
    const args = (adapter.args ?? []).map(substitute);
    const child = spawn(substitute(adapter.command ?? ''), args, {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      env: { ...process.env, ...(adapter.env ?? {}), NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, adapter.timeoutMs ?? 900_000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (!JSON_OUT) process.stderr.write(dim(String(chunk).slice(0, 400)));
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, text: '', durationMs: Date.now() - started, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      let text = stdout;
      if ((adapter.output === 'file' || adapter.output === undefined) && fs.existsSync(outputFile)) {
        const fromFile = fs.readFileSync(outputFile, 'utf8');
        if (fromFile.trim()) text = fromFile;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve({
        ok: code === 0,
        text,
        durationMs: Date.now() - started,
        error: code === 0 ? null : `退出码 ${code}：${stderr.slice(0, 300)}`,
      });
    });
    if ((adapter.input ?? 'stdin') === 'stdin') child.stdin.write(promptText);
    child.stdin.end();
  });
}

async function cmdAgentRun() {
  const tag = String(FLAGS.tag ?? CONFIG.tag ?? '').replace(/^@/, '');
  if (!tag) die('用法：ah agent run --tag codex-1 [--room general] [--all] [--once]');
  const room = await currentRoom();
  const cwd = path.resolve(String(FLAGS.cwd ?? process.cwd()));
  if (!fs.existsSync(cwd)) die(`工作目录不存在：${cwd}`);
  const adapter = await resolveEdgeAdapter(tag, room);
  if (!JSON_OUT) {
    out(
      `${green('边缘运行器启动')}：以 @${tag} 身份在「${room}」监听，使用适配器 ${bold(adapter.id ?? adapter.label ?? '')}` +
        `${FLAGS.all ? yellow('（所有消息都参与）') : '（仅被 @ 时参与）'}\n${dim(`工作目录 ${cwd}｜Ctrl+C 退出`)}`,
    );
  }
  let lastId = Number(FLAGS.after ?? 0);
  if (!lastId) {
    const head = await request(`/api/rooms/${encodeURIComponent(room)}/messages?limit=1`);
    lastId = head.messages.at(-1)?.id ?? 0;
  }
  for (;;) {
    const res = await request(
      `/api/events?room=${encodeURIComponent(room)}&after=${lastId}&timeout=${FLAGS.once ? 0 : 25000}`,
    );
    for (const message of res.messages ?? []) {
      lastId = Math.max(lastId, message.id);
      if (message.senderKind === 'system') continue;
      if (message.senderTag === tag) continue;
      const mentioned = (message.mentions ?? []).includes(tag);
      if (!mentioned && !FLAGS.all) continue;
      if (!JSON_OUT) out(dim(`→ 被唤醒：${fmtMessage(message)}`));
      const prepared = await request(
        `/api/rooms/${encodeURIComponent(room)}/agents/${tag}/prompt?trigger=${message.id}`,
      );
      if (FLAGS['dry-run']) {
        out(`\n${bold('=== 将发送给 CLI 的提示词 ===')}\n${prepared.prompt}\n`);
        continue;
      }
      const run = await runLocalAdapter(prepared.adapter, prepared.prompt, { cwd });
      if (!run.ok) {
        process.stderr.write(red(`✗ CLI 执行失败：${run.error}\n`));
        await request(`/api/agents/${tag}/runs`, {
          method: 'POST',
          body: {
            roomId: prepared.roomId,
            triggerMsgId: message.id,
            chainId: prepared.chainId,
            hop: prepared.hop,
            status: 'error',
            adapterId: prepared.adapter.id,
            durationMs: run.durationMs,
            error: run.error,
          },
        }).catch(() => {});
        continue;
      }
      const reply = await request(`/api/rooms/${encodeURIComponent(room)}/messages`, {
        method: 'POST',
        body: {
          text: run.text.trim(),
          replyTo: message.id,
          chainId: prepared.chainId,
          hop: prepared.hop,
          meta: { edge: true, adapter: prepared.adapter.id, durationMs: run.durationMs },
        },
      });
      await request(`/api/agents/${tag}/runs`, {
        method: 'POST',
        body: {
          roomId: prepared.roomId,
          triggerMsgId: message.id,
          chainId: prepared.chainId,
          hop: prepared.hop,
          status: 'ok',
          adapterId: prepared.adapter.id,
          durationMs: run.durationMs,
        },
      }).catch(() => {});
      if (!JSON_OUT) out(`${green('已回帖')} #${reply.message.id}（${run.durationMs}ms）`);
    }
    if (FLAGS.once) return;
  }
}

async function cmdDiscuss() {
  needAuth();
  const topic = String(FLAGS.topic ?? ARGS[1] ?? '');
  if (!topic) die('用法：ah discuss "主题" --with @codex-1,@claude-1 [--rounds 2]');
  const room = await currentRoom();
  const tags = String(FLAGS.with ?? FLAGS.tags ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean);
  const res = await request(`/api/rooms/${encodeURIComponent(room)}/discuss`, {
    method: 'POST',
    body: { topic, tags, rounds: Number(FLAGS.rounds ?? 2) },
  });
  if (JSON_OUT) return out(res);
  out(`${green('讨论已启动')}：「${topic}」参与者 ${tags.map((t) => `@${t}`).join('、') || '（房间内全部 AI）'}，${FLAGS.rounds ?? 2} 轮`);
  out(dim(`用 ah tail --room ${room} 实时查看讨论过程`));
}

async function cmdControl() {
  needAuth();
  const action = String(FLAGS.action ?? ARGS[1] ?? '');
  if (!['pause', 'resume', 'stop'].includes(action)) die('用法：ah control pause|resume|stop [--room general]');
  const room = await currentRoom();
  const res = await request(`/api/rooms/${encodeURIComponent(room)}/control`, {
    method: 'POST',
    body: { action },
  });
  return out(JSON_OUT ? res : `${green('已执行')} ${action} @ ${room}`);
}

async function cmdHealth() {
  const res = await request('/api/health', { auth: false });
  if (JSON_OUT) return out(res);
  out(
    `${green('AgentHub 服务正常')} v${res.version}｜Node ${res.node}｜${res.platform}\n` +
      `适配器：\n${res.adapters
        .map((a) => `  ${a.available ? green('✔') : red('✘')} ${a.id.padEnd(18)} ${dim(a.detail)}`)
        .join('\n')}`,
  );
}

async function cmdAdapters() {
  const res = await request('/api/adapters', { auth: false });
  if (JSON_OUT) return out(res);
  out(
    res.adapters
      .map(
        (a) =>
          `${a.available ? green('✔') : red('✘')} ${bold(a.id)}（${a.label}）\n  ${dim(a.description ?? '')}\n  ${dim(a.probeDetail ?? '')}`,
      )
      .join('\n'),
  );
}

async function cmdStatus() {
  const res = await request('/api/status', { auth: false });
  out(res);
}

async function cmdUsage() {
  const days = Number(FLAGS.days ?? 7) || 7;
  const query = new URLSearchParams({ days: String(days) });
  if (FLAGS.room ?? CONFIG.room) query.set('room', String(FLAGS.room ?? CONFIG.room));
  if (FLAGS.tag) query.set('tag', String(FLAGS.tag));
  const res = await request(`/api/usage?${query.toString()}`);
  if (JSON_OUT) return out(res);
  const rows = res.byAgent ?? [];
  if (!rows.length) return out(`最近 ${days} 天没有运行记录。`);
  const width = Math.max(...rows.map((r) => r.tag.length), 8);
  out(
    `${bold(`最近 ${days} 天用量`)}${res.room ? `｜房间「${res.room.name}」` : ''}\n` +
      rows
        .map(
          (r) =>
            `  @${r.tag.padEnd(width)}  ${String(r.tokensTotal).padStart(9)} tokens` +
            `${r.costUsd ? `  $${r.costUsd.toFixed(4)}` : ''}` +
            `  ${r.runs} 次调用（${r.measuredRuns} 次有上报）` +
            dim(`  ${Math.round(r.durationMs / 1000)}s`),
        )
        .join('\n') +
      `\n${dim('合计')} ${green(String(res.total?.tokensTotal ?? 0))} tokens｜${res.total?.runs ?? 0} 次调用` +
      `${res.total?.costUsd ? `｜$${Number(res.total.costUsd).toFixed(4)}` : ''}\n` +
      dim('说明：只有 CLI 自己上报了 token 才会计入（codex/claude 会报，多数本地模型不会）。'),
  );
}

/* ------------------------------- doctor ------------------------------- */

/**
 * doctor 专用的「不退出进程」请求：诊断脚本要把每个失败都收集起来一起报告，
 * 不能像正式命令那样一遇到错误就 die()。
 */
async function softRequest(pathname, { auth = true } = {}) {
  const url = `${CONFIG.server.replace(/\/+$/, '')}${pathname}`;
  const headers = {};
  if (auth && CONFIG.token) headers.Authorization = `Bearer ${CONFIG.token}`;
  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err?.message ?? String(err), data: {} };
  }
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '未知';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * ah doctor —— 一条命令把「为什么用不了」查清楚：
 * 服务连通 / 磁盘余量 / 身份凭据 / 默认房间 / 适配器可用性 / 自签证书提示。
 * 有 FAIL 时退出码为 1，可以直接放进脚本里当健康门禁。
 */
async function cmdDoctor() {
  const rows = [];
  const add = (level, name, detail) => rows.push({ level, name, detail: detail ?? '' });

  add(
    'info',
    '服务地址',
    `${CONFIG.server}｜profile「${profileName}」${CONFIG.insecure ? '｜--insecure（跳过证书校验）' : ''}`,
  );

  /* 1. 连通性 */
  const health = await softRequest('/api/health', { auth: false });
  if (!health.ok) {
    add('fail', '服务连通', health.error ? `连不上：${health.error}` : `HTTP ${health.status} ${health.data?.error ?? ''}`);
  } else {
    add('ok', '服务连通', `AgentHub v${health.data.version}｜Node ${health.data.node}｜${health.data.platform}`);
  }

  /* 2. 运行状态与磁盘 */
  const status = await softRequest('/api/status', { auth: false });
  if (status.ok) {
    const rt = status.data.runtime ?? {};
    const orch = status.data.orchestrator ?? {};
    const online = (rt.online ?? []).join('、') || '（无人在线）';
    add(
      'info',
      '运行状态',
      `在线：${online}｜活动任务 ${orch.activeRuns ?? 0}｜排队 ${JSON.stringify(orch.queues ?? {})}｜已暂停房间 ${
        (orch.pausedRooms ?? []).length
      }`,
    );
    if (rt.disk?.free != null) {
      const low = rt.disk.free < 1024 ** 3;
      add(low ? 'warn' : 'ok', '磁盘余量', `${humanBytes(rt.disk.free)} / ${humanBytes(rt.disk.total)}（数据目录 ${rt.dataDir ?? '-'}）`);
    }
  }

  /* 3. 身份凭据 */
  if (!CONFIG.token || !CONFIG.tag) {
    add('warn', '身份凭据', `profile「${profileName}」没登录：ah register --tag <tag> --nickname <昵称> 或 ah login --tag <tag> --token <token>`);
  } else {
    const me = await softRequest('/api/me');
    if (!me.ok) {
      add('fail', '身份凭据', `@${CONFIG.tag} 校验失败（HTTP ${me.status}${me.data?.error ? `：${me.data.error}` : ''}）`);
    } else {
      add(
        'ok',
        '身份凭据',
        `@${me.data.member.tag}（${me.data.member.nickname}）role=${me.data.member.role}｜${(me.data.rooms ?? []).length} 个房间`,
      );
    }
  }

  /* 4. 默认房间（profile 里的 room，或 --room 指定） */
  const roomName = FLAGS.room ?? CONFIG.room;
  if (!roomName) {
    add('warn', '默认房间', 'profile 里没设默认房间：发送时会要求显式 --room（ah room use <房间> 可设）');
  } else {
    const room = await softRequest(`/api/rooms/${encodeURIComponent(roomName)}`);
    if (!room.ok) {
      add('fail', '默认房间', `「${roomName}」读不到（HTTP ${room.status}${room.data?.error ? `：${room.data.error}` : ''}）`);
    } else {
      const r = room.data.room;
      const members = r.memberTags ?? [];
      add('ok', '默认房间', `${r.name}｜${members.length} 成员 / ${r.messageCount} 条消息｜邀请码 ${r.code}`);
      if (CONFIG.tag && !members.includes(CONFIG.tag)) {
        add('fail', '房间成员身份', `@${CONFIG.tag} 不在「${r.name}」成员列表里，发言会被 403（ah room join ${r.name} --tag ${CONFIG.tag}）`);
      }
    }
  }

  /* 5. 适配器（AI CLI 能不能起进程，全看这里） */
  const adapters = await softRequest('/api/adapters', { auth: false });
  if (adapters.ok) {
    const list = adapters.data.adapters ?? [];
    const usable = list.filter((a) => a.available && !a.disabled);
    add(
      usable.length ? 'ok' : 'warn',
      '适配器',
      `可用 ${usable.length}/${list.length}：${usable.map((a) => a.id).join('、') || '（一个都没有）'}`,
    );
    for (const a of list.filter((x) => !x.available && !x.disabled)) {
      add('warn', `适配器 ${a.id}`, `${a.probeDetail ?? '不可用'}｜可设 AH_CLI_SEARCH_PATHS 或改 data/adapters.json 指定路径`);
    }
  }

  /* 6. 文档（外部 AI 自接入时最常问的就是「接口在哪」） */
  const openapi = await softRequest('/openapi.json', { auth: false });
  // 注意：前端是 SPA fallback，任何未知路径都会返回 200 的 index.html，
  // 所以这里必须校验拿到的是不是真的 OpenAPI 文档，不能只看状态码。
  const openapiOk = openapi.ok && Boolean(openapi.data?.openapi);
  add(
    openapiOk ? 'ok' : 'warn',
    '接口文档',
    openapiOk
      ? `${CONFIG.server}/openapi.json｜${CONFIG.server}/llms.txt`
      : `拿不到 /openapi.json（HTTP ${openapi.status}；服务端可能是旧版本，重新构建后重启）`,
  );

  if (JSON_OUT) {
    return out({ ok: !rows.some((r) => r.level === 'fail'), checks: rows });
  }

  const mark = { ok: green('✔'), warn: yellow('!'), fail: red('✘'), info: dim('·') };
  out(
    `${bold('AgentHub 自检（ah doctor）')}\n` +
      rows.map((r) => `  ${mark[r.level] ?? '·'} ${r.name.padEnd(14)} ${dim(r.detail)}`).join('\n'),
  );
  const fails = rows.filter((r) => r.level === 'fail');
  const warns = rows.filter((r) => r.level === 'warn');
  if (fails.length) {
    process.stderr.write(`\n${red(`${fails.length} 项不通过`)}${warns.length ? `，${warns.length} 项提醒` : ''}\n`);
    process.exit(1);
  }
  process.stdout.write(`\n${green('没有发现阻塞性问题')}${warns.length ? `（${warns.length} 项提醒，见上）` : ''}\n`);
}

/* -------------------------------- 分发 -------------------------------- */

const table = {
  help: async () => out(HELP),
  register: cmdRegister,
  login: cmdLogin,
  whoami: cmdWhoami,
  rooms: cmdRooms,
  room: cmdRoom,
  send: cmdSend,
  history: cmdHistory,
  tail: cmdTail,
  inbox: cmdInbox,
  files: cmdFiles,
  agent: cmdAgent,
  discuss: cmdDiscuss,
  control: cmdControl,
  health: cmdHealth,
  adapters: cmdAdapters,
  status: cmdStatus,
  doctor: cmdDoctor,
  usage: cmdUsage,
};

const handler = table[COMMAND];
if (!handler) {
  process.stderr.write(red(`未知命令 ${COMMAND}\n\n`));
  out(HELP);
  process.exit(1);
}
await handler();
