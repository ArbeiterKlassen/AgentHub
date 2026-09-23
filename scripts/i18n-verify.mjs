/**
 * 本地化验收：临时账号 + 临时房间，先用中文截一张、再切英文截一张，
 * 并断言「界面标签」「六个弹窗」与「服务端系统消息」都跟着语言变。
 *
 *   node scripts/i18n-verify.mjs [--app https://127.0.0.1:8787]
 *
 * 可选：设 AH_ADMIN_TOKEN=<管理员 token> 可把自检留下的临时 AI 成员也一并删掉。
 * 截图落在 data/tmp/（不入库）。
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const APP = argValue('app', 'https://127.0.0.1:8787');
/** 可选：给了管理员 token 就能连自检用的临时 AI 成员一起删掉，不给也能跑（只是留个空号） */
const ADMIN = process.env.AH_ADMIN_TOKEN ?? '';
const SHOT_DIR = path.join(REPO, 'data', 'tmp');
const PORT = await new Promise((resolve) => {
  import('node:net').then(({ default: net }) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
});
const sfx = Math.random().toString(36).slice(2, 6);
const tag = `i18n-${sfx}`;
fs.mkdirSync(SHOT_DIR, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
};

const call = async (method, p, { token, body, raw, headers = {} } = {}) => {
  const res = await fetch(`${APP}${p}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  try {
    return { status: res.status, data: text ? JSON.parse(text) : {} };
  } catch {
    return { status: res.status, data: { raw: text.slice(0, 200) } };
  }
};

const me = (await call('POST', '/api/register', { body: { tag, nickname: '本地化验收', kind: 'human' } })).data;
/* 顺带挂一个 external 适配器的 AI 成员：讨论弹窗与运行记录弹窗需要有 AI 才点得开 */
const agentTag = `i18na-${sfx}`;
await call('POST', '/api/register', {
  body: { tag: agentTag, nickname: '本地化验收 AI', kind: 'agent', adapterId: 'external' },
});
const room = (await call('POST', '/api/rooms', { token: me.token, body: { name: `i18n-room-${sfx}`, members: [agentTag] } }))
  .data.room;
await call('POST', `/api/rooms/${room.id}/files`, {
  token: me.token,
  raw: Buffer.from('hello'),
  headers: { 'content-type': 'text/plain', 'X-File-Name': encodeURIComponent('演示文件.txt') },
});
console.log(`临时账号 @${tag}，房间 ${room.name}`);

const browserPath = fs.existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.join(process.env.TEMP ?? '.', `ah-i18n-${Date.now().toString(36)}`);
const child = spawn(
  browserPath,
  [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--ignore-certificate-errors', '--disable-gpu', '--no-first-run', '--window-size=1280,900', 'about:blank'],
  { detached: true, stdio: 'ignore', windowsHide: true },
);
child.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target = null;
for (let i = 0; i < 20 && !target; i += 1) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  } catch {
    /* 等浏览器 */
  }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const d = JSON.parse(ev.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, label, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(expr).catch(() => false)) return true;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(400);
  }
};
const fill = (sel, value) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    const proto = window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
const shot = async (file) => {
  const data = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(data.result.data, 'base64'));
  console.log(`  截图 → ${file}`);
};
/** 点到元素（Radix 的 tab / 菜单都吃 pointerdown + click 这一套） */
const clickEl = (js) =>
  evaluate(`(() => {
    const el = ${js};
    if (!el) return false;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    el.click();
    return true;
  })()`);
const clickTitle = (title) =>
  clickEl(`[...document.querySelectorAll('button[title]')].find((x) => x.getAttribute('title') === ${JSON.stringify(title)})`);
const clickTab = (text) =>
  clickEl(
    `[...document.querySelectorAll('[role="tab"]')].find((x) => (x.textContent || '').trim().startsWith(${JSON.stringify(text)}))`,
  );
const dialogText = () =>
  evaluate(
    `[...document.querySelectorAll('[role="dialog"]')].map((d) => d.innerText).join('\\n').trim()`,
  );
/** placeholder 不在 innerText 里，单独取一遍 */
const dialogPlaceholders = () =>
  evaluate(`[...document.querySelectorAll('[role="dialog"] input')].map((i) => i.placeholder).join(' | ')`);
const searchPlaceholder = () =>
  evaluate(`(document.querySelector('input[placeholder]') || {}).placeholder || ''`);
const pressEscape = async () => {
  const base = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
};
const closeDialogs = async (closerLabel = '关闭') => {
  await pressEscape();
  await sleep(400);
  if (await evaluate(`document.querySelectorAll('[role="dialog"]').length > 0`)) {
    await clickEl(
      `[...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(closerLabel)})`,
    );
    await sleep(400);
  }
  return !(await evaluate(`document.querySelectorAll('[role="dialog"]').length > 0`));
};

await send('Page.enable');
await send('Runtime.enable');
try {
  await send('Page.navigate', { url: APP });
  await sleep(2500);
  await waitFor(`document.body.innerText.includes('进入群聊')`, '中文登录页');
  check('默认语言为中文（界面显示「进入群聊」）', true);

  await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const t = tabs.find((x) => (x.textContent || '').includes('token'));
    if (t) for (const type of ['mousedown','mouseup','click']) t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`);
  await sleep(300);
  await fill('#login-tag-2', tag);
  await fill('#login-token', me.token);
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].reverse().find((x) => (x.textContent || '').trim() === '登录');
    if (b) b.click();
    return Boolean(b);
  })()`);
  await waitFor(`document.body.innerText.includes('群聊房间')`, '进入主界面（中文）');
  const zhText = String(await evaluate('document.body.innerText'));
  check('中文界面：侧栏标题与系统消息都是中文', zhText.includes('群聊房间') && zhText.includes('房间「') && zhText.includes('上传了文件'), '');

  /* 中文弹窗：新建群聊 / 邀请码 / 分组 / 搜索 / 讨论 / 运行记录 */
  check(
    '中文：侧栏三个入口按钮已本地化',
    await evaluate(`(() => {
      const titles = [...document.querySelectorAll('button[title]')].map((b) => b.getAttribute('title'));
      return ['新建群聊', '用邀请码加入群聊', '群聊分组'].every((x) => titles.includes(x));
    })()`),
  );
  await clickTitle('新建群聊');
  await sleep(700);
  const zhNewRoom = await dialogText();
  check('中文：新建群聊弹窗', zhNewRoom.includes('新建群聊房间') && zhNewRoom.includes('初始成员') && zhNewRoom.includes('取消'), '');
  await closeDialogs('关闭');

  await clickTitle('用邀请码加入群聊');
  await sleep(700);
  const zhJoin = await dialogText();
  check('中文：邀请码弹窗', zhJoin.includes('用邀请码加入群聊') && zhJoin.includes('邀请码') && zhJoin.includes('加入群聊'), '');
  await closeDialogs('关闭');

  await clickTitle('群聊分组');
  await sleep(700);
  const zhGroups = await dialogText();
  const zhGroupPh = await dialogPlaceholders();
  check(
    '中文：分组管理弹窗',
    zhGroups.includes('群聊分组') && zhGroupPh.includes('新分组名') && zhGroups.includes('新建'),
    zhGroups.replace(/\n+/g, ' | ').slice(0, 100),
  );
  await closeDialogs('关闭');

  await clickTitle('搜索消息 / 导出聊天记录');
  await sleep(700);
  const zhSearch = String(await evaluate('document.body.innerText'));
  const zhSearchPh = await searchPlaceholder();
  check(
    '中文：搜索弹窗',
    zhSearch.includes('输入关键词后回车即搜') &&
      zhSearch.includes('导出本群聊天记录') &&
      zhSearchPh.startsWith('在「'),
    zhSearchPh,
  );
  await clickEl(`[...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Esc')`);
  await sleep(600);
  check('中文：搜索弹窗能关掉', !String(await evaluate('document.body.innerText')).includes('输入关键词后回车即搜'));

  await clickTab('AI');
  await sleep(700);
  await clickTitle('运行记录');
  await sleep(900);
  const zhLogs = await dialogText();
  check('中文：运行记录弹窗', zhLogs.includes('的运行记录') && zhLogs.includes('暂无运行记录') && zhLogs.includes('刷新'), '');
  await closeDialogs('关闭');

  await clickTitle('发起多 AI 讨论');
  await sleep(700);
  const zhDiscuss = await dialogText();
  check('中文：多 AI 讨论弹窗', zhDiscuss.includes('发起多 AI 讨论') && zhDiscuss.includes('参与者') && zhDiscuss.includes('开始讨论'), '');
  await closeDialogs('关闭');
  check('中文：所有弹窗都能关掉（没有卡住的遮罩）', await evaluate(`document.querySelectorAll('[role="dialog"]').length === 0`));
  await shot(path.join(SHOT_DIR, 'i18n-zh.png'));

  // 切英文：改 localStorage 后刷新（等价于点右上角语言按钮）
  await evaluate(`localStorage.setItem('agenthub-locale','en-US')`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(4000);
  const afterReload = String(await evaluate('document.body.innerText')).slice(0, 300).replace(/\n+/g, ' | ');
  const switched = await waitFor(`document.body.innerText.includes('AI members')`, '英文界面', 10000).catch(() => false);
  if (!switched) {
    console.log(`  [诊断] 刷新后页面文本：${afterReload}`);
    console.log(`  [诊断] localStorage locale = ${await evaluate(`localStorage.getItem('agenthub-locale')`)}`);
  }
  const enText = String(await evaluate('document.body.innerText'));
  console.log(`  [诊断] 英文页面文本：${enText.slice(0, 420).replace(/\n+/g, ' | ')}`);
  check(
    '英文界面：侧栏与顶部导航已翻译',
    enText.includes('AI members') && enText.includes('Settings') && enText.includes('Ungrouped') && enText.includes('Pause'),
  );
  check('英文界面：系统消息按模板翻译（房间创建 + 文件上传）', /Room ".*" created by @/.test(enText) && /uploaded .*\.txt/.test(enText), '');
  check('英文界面：中文原文不再出现', !enText.includes('群聊房间') && !enText.includes('上传了文件'));
  check(
    '英文界面：右侧面板已翻译（页签 / 邀请码 / 导出 / 文件区）',
    enText.includes('Members') && enText.includes('Room code (invite code)') && enText.includes('Export chat history'),
  );

  /* 房间设置弹窗：既要是英文，又不能是长篇叙述 */
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('Room settings'));
    if (btn) btn.click();
    return Boolean(btn);
  })()`);
  await sleep(1000);
  const settingsDialog = String(await evaluate('document.body.innerText'));
  check(
    '英文界面：房间设置弹窗已翻译',
    settingsDialog.includes('Room settings') &&
      settingsDialog.includes('Context budget') &&
      settingsDialog.includes('Hand-off and progress') &&
      settingsDialog.includes('Delete room'),
  );
  check(
    '房间设置文案已精简（说明句都在 40 字以内）',
    settingsDialog.includes('Default 24.') && settingsDialog.includes('Default 6000.') && !settingsDialog.includes('并在提示词里说明'),
  );
  check('房间设置弹窗无中文残留', !/房间设置|上下文预算|解散房间/.test(settingsDialog));
  await shot(path.join(SHOT_DIR, 'i18n-room-settings-en.png'));
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Cancel');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(500);

  /* 英文：另外六个弹窗 */
  check(
    '英文：侧栏三个入口按钮已翻译',
    await evaluate(`(() => {
      const titles = [...document.querySelectorAll('button[title]')].map((b) => b.getAttribute('title'));
      return ['New room', 'Join with an invite code', 'Room groups'].every((x) => titles.includes(x));
    })()`),
  );
  await clickTitle('New room');
  await sleep(700);
  const enNewRoom = await dialogText();
  const enNewRoomPh = await dialogPlaceholders();
  check(
    '英文：新建群聊弹窗已翻译',
    enNewRoom.includes('New room') && enNewRoom.includes('Initial members') && enNewRoom.includes('Cancel'),
    enNewRoom.replace(/\n+/g, ' | ').slice(0, 120),
  );
  check('英文：新建群聊弹窗无中文残留', !/新建|初始成员|取消/.test(enNewRoom));
  check('英文：新建群聊弹窗的占位提示也已翻译', !/[\u4e00-\u9fff]/.test(enNewRoomPh), enNewRoomPh);
  await closeDialogs('Close');

  await clickTitle('Join with an invite code');
  await sleep(700);
  const enJoin = await dialogText();
  const enJoinPh = await dialogPlaceholders();
  check(
    '英文：邀请码弹窗已翻译',
    enJoin.includes('Join a room with an invite code') && enJoin.includes('Invite code') && enJoin.includes('Join room'),
  );
  check('英文：邀请码弹窗无中文残留', !/邀请码|加入群聊/.test(enJoin));
  check('英文：邀请码弹窗的占位提示也已翻译', !/[\u4e00-\u9fff]/.test(enJoinPh), enJoinPh);
  await closeDialogs('Close');

  await clickTitle('Room groups');
  await sleep(700);
  const enGroups = await dialogText();
  const enGroupPh = await dialogPlaceholders();
  check(
    '英文：分组管理弹窗已翻译',
    enGroups.includes('Chat groups') && enGroupPh.includes('New group name') && enGroups.includes('Create'),
    enGroups.replace(/\n+/g, ' | ').slice(0, 100),
  );
  check('英文：分组管理弹窗无中文残留', !/群聊分组|新分组名|新建/.test(enGroups));
  check('英文：分组弹窗的输入提示也已翻译', !/[\u4e00-\u9fff]/.test(enGroupPh), enGroupPh);
  await closeDialogs('Close');

  await clickTitle('Search messages and export history');
  await sleep(700);
  const enSearch = String(await evaluate('document.body.innerText'));
  const enSearchPh = await searchPlaceholder();
  check(
    '英文：搜索弹窗已翻译',
    enSearch.includes('Type a keyword and press Enter') &&
      enSearch.includes("Export this room's history") &&
      enSearchPh.startsWith('Search messages in'),
    enSearchPh,
  );
  check('英文：搜索弹窗无中文残留', !/输入关键词|导出本群聊天记录|最多 5000 条/.test(enSearch));
  await clickEl(`[...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Esc')`);
  await sleep(600);

  await clickTab('AI');
  await sleep(700);
  await clickTitle('Run records');
  await sleep(900);
  const enLogs = await dialogText();
  check(
    '英文：运行记录弹窗已翻译',
    enLogs.includes('Run log for @') && enLogs.includes('No runs yet') && enLogs.includes('Refresh'),
    enLogs.replace(/\n+/g, ' | ').slice(0, 120),
  );
  check('英文：运行记录弹窗无中文残留', !/运行记录|暂无|刷新|适配器/.test(enLogs));
  await closeDialogs('Close');

  await clickTitle('Start a multi-AI discussion');
  await sleep(700);
  const enDiscuss = await dialogText();
  check(
    '英文：多 AI 讨论弹窗已翻译',
    enDiscuss.includes('Start a multi-AI discussion') &&
      enDiscuss.includes('Participants (all AIs by default)') &&
      enDiscuss.includes('Start discussion'),
    enDiscuss.replace(/\n+/g, ' | ').slice(0, 120),
  );
  check('英文：多 AI 讨论弹窗无中文残留', !/发起多 AI 讨论|参与者|开始讨论|轮数/.test(enDiscuss));
  await closeDialogs('Close');
  check('英文：所有弹窗都能关掉', await evaluate(`document.querySelectorAll('[role="dialog"]').length === 0`));

  /* AI 成员页 */
  await send('Page.navigate', { url: `${APP}/agents` });
  await sleep(2500);
  const agentsText = String(await evaluate('document.body.innerText'));
  check(
    '英文界面：AI 成员页已翻译',
    agentsText.includes('AI members') && agentsText.includes('New AI member') && agentsText.includes('Adapter availability'),
    agentsText.includes('AI members') ? '' : agentsText.slice(0, 100).replace(/\n+/g, ' | '),
  );
  check('AI 成员页无中文残留', !agentsText.includes('新增 AI 成员') && !agentsText.includes('适配器可用性'));
  await shot(path.join(SHOT_DIR, 'i18n-agents-en.png'));

  await evaluate(`(() => {
    const link = [...document.querySelectorAll('a')].find((a) => (a.getAttribute('href') || '') === '/settings');
    if (link) link.click();
    return Boolean(link);
  })()`);
  await sleep(1500);
  const settingsText = String(await evaluate('document.body.innerText'));
  check(
    '英文界面：设置页已翻译',
    settingsText.includes('My identity') && settingsText.includes('Danger zone') && settingsText.includes('CLI cheat sheet'),
    settingsText.includes('My identity') ? '' : settingsText.slice(0, 120).replace(/\n+/g, ' | '),
  );
  check('英文设置页无中文残留', !settingsText.includes('我的身份') && !settingsText.includes('危险操作'));
  await shot(path.join(SHOT_DIR, 'i18n-en.png'));
} catch (err) {
  check('验收脚本未抛异常', false, err instanceof Error ? err.message : String(err));
} finally {
  ws.close();
  try {
    process.kill(child.pid);
  } catch {
    /* ignore */
  }
  // 房间是临时账号自己建的，用他自己的 token 就能解散；删成员需要管理员
  await call('DELETE', `/api/rooms/${room.id}`, { token: me.token }).catch(() => {});
  const cleaner = ADMIN || me.token;
  await call('DELETE', `/api/members/${tag}?force=1`, { token: cleaner }).catch(() => {});
  await call('DELETE', `/api/members/${agentTag}?force=1`, { token: cleaner }).catch(() => {});
  console.log(
    ADMIN
      ? '（临时账号与房间已清理）'
      : '（临时房间已清理；没给 AH_ADMIN_TOKEN，临时 AI 成员留着了，可用 scripts/prune-test-members.mjs 清掉）',
  );
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}
