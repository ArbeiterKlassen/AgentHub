#!/usr/bin/env node
/**
 * 前端 UI 自动化自检（通过 Chrome DevTools Protocol 驱动真实浏览器）
 *
 *   1) 先启动后端：npm run dev:server      （默认 http://127.0.0.1:8787）
 *   2) 再启动前端：npm run dev:web         （默认 http://localhost:5173）
 *   3) 用一个带调试端口的浏览器打开空白页：
 *        msedge.exe --headless=new --remote-debugging-port=9227 --user-data-dir=<临时目录> about:blank
 *      或直接运行：node scripts/ui-test.mjs --launch
 *   4) node scripts/ui-test.mjs
 *
 * 覆盖：注册进入 / 新建房间 / 拉 AI 进群 / 发消息 @AI / 收到 AI 回帖 / 上传共享文件 / 截图
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const PORT = Number(flag('port', 9227));
const APP = String(flag('app', 'http://localhost:5173'));
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(REPO, 'docs', 'screenshots');
const RUN = Date.now().toString(36).slice(-4);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'} ${name}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`);
}

async function findTarget() {
  for (let i = 0; i < 20; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error(`连不上调试端口 ${PORT}，请先用 --remote-debugging-port=${PORT} 启动浏览器`);
}

function createClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let msgId = 0;
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    }
  };
  const send = (method, params = {}, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      pending.set(id, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, ready };
}

async function main() {
  if (flag('launch')) {
    const browser =
      [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : '',
      ].find((p) => p && fs.existsSync(p)) ?? '';
    if (!browser) throw new Error('没找到 Edge/Chrome，请手动启动带调试端口的浏览器');
    const profile = path.join(process.env.TEMP ?? '.', `agenthub-ui-${RUN}`);
    spawn(
      browser,
      [
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${profile}`,
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--window-size=1440,960',
        'about:blank',
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    ).unref();
    await sleep(2500);
  }

  const target = await findTarget();
  const client = createClient(target.webSocketDebuggerUrl);
  await client.ready;
  const { send } = client;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const evaluate = async (expression, { awaitPromise = true } = {}) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text);
    return res.result?.result?.value;
  };

  const screenshot = async (name) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(SHOT_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(res.result.data, 'base64'));
    console.log(`     截图 → ${path.relative(REPO, file)}`);
    return file;
  };

  const waitFor = async (expression, { timeoutMs = 15000, label = expression } = {}) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await evaluate(expression).catch(() => false);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
      await sleep(300);
    }
  };

  /** React 受控组件必须用原生 setter + input 事件才能触发 onChange */
  const setValue = (selector, value) =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

  const clickText = (text, tag = '*') =>
    evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(tag)})];
      const el = nodes.reverse().find((n) => n.textContent && n.textContent.includes(${JSON.stringify(text)}));
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** Radix 的 Tabs 用 mousedown 激活，纯 .click() 不会切换 */
  const clickTab = (prefix) =>
    evaluate(`(() => {
      const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => (t.textContent || '').trim().startsWith(${JSON.stringify(prefix)}));
      if (!tab) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        tab.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })()`);

  const bodyText = () => evaluate('document.body.innerText');

  /** 失败时把页面文字打出来，便于定位是选择器变了还是页面没渲染 */
  const dump = async (label) => {
    const text = await bodyText().catch(() => '(无法读取页面)');
    console.log(`     \u001b[2m[${label}] 当前页面文本：${String(text).replace(/\n+/g, ' | ').slice(0, 600)}\u001b[0m`);
  };

  console.log(`\n=== AgentHub 前端自检 ===\n应用：${APP}\n`);

  // 1. 打开登录页
  await send('Page.navigate', { url: APP });
  await sleep(2500);
  await waitFor(`document.body.innerText.includes('进入群聊')`, { label: '登录页渲染' });
  check('登录页可以打开', true);
  await screenshot('01-login');

  // 2. 注册一个新的人类身份
  const tag = `ui-${RUN}`;
  await setValue('#login-tag', tag);
  await setValue('#login-nickname', `UI 测试 ${RUN}`);
  await clickText('注册并进入', 'button');
  const entered = await waitFor(`!document.body.innerText.includes('进入群聊')`, {
    timeoutMs: 20000,
    label: '注册并进入主界面',
  }).catch(() => false);
  check('注册后进入主界面', Boolean(entered));

  // 3. 新建房间（把 mock 适配器的 AI 拉进来）
  await waitFor(`document.body.innerText.includes('群聊房间')`, { label: '主界面加载' });
  const plusClicked = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const plus = btns.find((b) => (b.title || '').includes('新建群聊')) ||
      btns.find((b) => (b.textContent || '').includes('新建群聊房间'));
    if (plus) plus.click();
    return Boolean(plus);
  })()`);
  const dialogOpen = await waitFor(`Boolean(document.querySelector('#room-name'))`, {
    timeoutMs: 8000,
    label: '新建房间弹窗',
  }).catch(() => false);
  check('新建房间弹窗可以打开', Boolean(dialogOpen), plusClicked ? '' : '没找到新建按钮');
  if (!dialogOpen) await dump('新建房间');
  const roomName = `UI 验证 ${RUN}`;
  await setValue('#room-name', roomName);
  await sleep(800);
  const picked = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const targets = buttons.filter((b) => /@codex-1|@claude-1/.test(b.textContent || ''));
    targets.slice(0, 2).forEach((b) => b.click());
    return targets.length;
  })()`);
  check('弹窗里能看到已有的 AI 成员', Number(picked) > 0, `匹配到 ${picked} 个成员按钮`);
  if (!picked) await dump('成员列表');
  await clickText('创建', 'button');
  const roomReady = await waitFor(
    `Boolean(document.querySelector('textarea')) && document.body.innerText.includes(${JSON.stringify(roomName)})`,
    { timeoutMs: 20000, label: '房间创建完成' },
  ).catch(() => false);
  check('创建房间并进入聊天界面', Boolean(roomReady), roomName);
  if (!roomReady) await dump('创建房间后');

  // 4. 发消息 @AI，等待回复
  const mentioned = await evaluate(`(() => {
    const el = document.querySelector('textarea');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, '@codex-1 请用一句话说明你能做什么');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  check('输入框可以输入消息', Boolean(mentioned));
  const sendClicked = await evaluate(`(() => {
    const btn = document.querySelector('button[title^="发送"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check('发送按钮存在且可点击', Boolean(sendClicked));
  await sleep(500);
  const sent = await waitFor(`document.body.innerText.includes('请用一句话说明你能做什么')`, {
    label: '消息出现在聊天区',
  }).catch(() => false);
  check('消息发送成功并出现在聊天区', Boolean(sent));

  const replied = await waitFor(`document.body.innerText.includes('内置模拟 AI')`, {
    timeoutMs: 25000,
    label: 'AI 回帖',
  }).catch(() => false);
  check('AI 成员在界面上完成回帖', Boolean(replied));
  await screenshot('02-chat');

  // 5. 共享文件区
  const uploaded = await evaluate(`(async () => {
    const session = JSON.parse(localStorage.getItem('agenthub-session') || '{}');
    const token = session?.state?.token;
    if (!token) return 'no-token';
    const canvas = document.createElement('canvas');
    canvas.width = 96; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#3b82f6'; ctx.fillRect(0, 0, 96, 64);
    ctx.fillStyle = '#ffffff'; ctx.font = '20px sans-serif'; ctx.fillText('IMG', 22, 40);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const file = new File([blob], 'ui-image-check.png', { type: 'image/png' });
    const res = await fetch('/api/rooms/' + encodeURIComponent(${JSON.stringify(roomName)}) + '/files', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'X-File-Name': encodeURIComponent(file.name),
        'Content-Type': 'image/png',
      },
      body: file,
    });
    return res.ok ? 'ok' : 'http-' + res.status;
  })()`);
  check('可以往聊天里上传图片', uploaded === 'ok', String(uploaded));

  const imageShown = await waitFor(
    `(() => { const img = document.querySelector('img[src*="/api/files/"]'); return Boolean(img && img.naturalWidth > 0); })()`,
    { timeoutMs: 20000, label: '图片内联预览' },
  ).catch(() => false);
  check('图片在聊天里内联预览（缩略图已解码）', Boolean(imageShown));
  if (!imageShown) await dump('图片预览');
  await screenshot('07-image-preview');

  const fileTabClicked = await clickTab('文件');
  await sleep(600);
  const filesTabVisible = await evaluate(`document.body.innerText.includes('上传文件到共享文件区')`);
  check('共享文件区面板可以打开', Boolean(filesTabVisible), fileTabClicked ? '' : '没找到「文件」标签页');
  if (!filesTabVisible) {
    const tabs = await evaluate(
      `JSON.stringify([...document.querySelectorAll('[role="tab"]')].map((t) => (t.textContent || '').trim()))`,
    );
    const panels = await evaluate(
      `JSON.stringify([...document.querySelectorAll('[role="tabpanel"]')].map((p) => (p.textContent || '').trim().slice(0, 60)))`,
    );
    console.log(
      `     \u001b[2m[文件面板] Tab 列表：${tabs}；面板：${panels}；右侧面板数量：${await evaluate(
        "document.querySelectorAll('aside').length",
      )}\u001b[0m`,
    );
    await dump('文件面板');
  }
  await screenshot('03-files');

  await clickTab('AI');
  await sleep(600);
  const agentsVisible = await evaluate(
    `document.body.innerText.includes('暂停接力') || document.body.innerText.includes('恢复接力')`,
  );
  check('AI 状态面板可以打开', Boolean(agentsVisible));
  await screenshot('04-agents-panel');

  // 6. AI 成员页
  await evaluate(`(() => {
    const link = [...document.querySelectorAll('a')].find((a) => (a.textContent || '').includes('AI 成员'));
    if (link) link.click();
    return Boolean(link);
  })()`);
  const agentsPageLoaded = await waitFor(`document.body.innerText.includes('CLI 登录命令')`, {
    timeoutMs: 15000,
    label: 'AI 成员页',
  }).catch(() => false);
  const agentsPageOk = await bodyText();
  check(
    'AI 成员页可以打开',
    agentsPageOk.includes('适配器可用性') && agentsPageOk.includes('codex'),
    agentsPageLoaded ? '' : '等待 AI 成员列表超时',
  );
  if (!agentsPageLoaded) await dump('AI 成员页');
  await screenshot('05-agents-page');

  // 7. 设置页
  await evaluate(`(() => {
    const link = [...document.querySelectorAll('a')].find((a) => (a.textContent || '').includes('设置'));
    if (link) link.click();
    return Boolean(link);
  })()`);
  await waitFor(`document.body.innerText.includes('CLI 速查')`, { timeoutMs: 15000, label: '设置页' });
  check('设置页可以打开（含 CLI 速查）', true);
  await screenshot('06-settings');

  client.ws.close();
}

try {
  await main();
} catch (err) {
  check(`执行中断：${err.message}`, false);
}

const failed = results.filter((r) => !r.pass);

// 清掉本轮的测试账号与测试房间
const RUNTAG = `ui-${RUN}`;
try {
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(
    process.execPath,
    [
      path.join(REPO, 'scripts', 'prune-test-members.mjs'),
      '--pattern',
      `^${RUNTAG}$`,
      '--rooms-pattern',
      `UI 验证 ${RUN}`,
      '--apply',
    ],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
  );
  const line = String(res.stdout ?? '').split(/\r?\n/).find((l) => l.includes('已删除'));
  if (line) console.log(`\n${line.trim()}`);
} catch {
  /* 清理失败不影响自检结论 */
}

console.log(`\n通过 ${results.length - failed.length}/${results.length} 项${failed.length ? `\n未通过：${failed.map((f) => f.name).join('、')}` : '\n全部通过 ✅'}`);
process.exit(failed.length ? 1 : 0);
