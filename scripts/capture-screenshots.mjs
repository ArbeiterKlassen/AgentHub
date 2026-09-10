#!/usr/bin/env node
/**
 * 给 README 拍截图：用真实浏览器登录 → 逐页截图（登录页 / 群聊 / 文件区 / AI 面板 / AI 成员页 / 设置 / 图片大图 / 暗色主题）。
 *
 *   node scripts/capture-screenshots.mjs --launch --app http://127.0.0.1:8899 --tag lan --token <token> --room 产品设计评审
 *
 * 建议在一个「演示数据」实例上跑（AH_DATA_DIR 指向临时目录 + 单独端口），这样截图里不会出现真实房间名。
 * 输出目录默认 docs/screenshots，可用 --out 指定。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const CDP_PORT = Number(flag('port', 9227));
const APP = String(flag('app', 'http://127.0.0.1:8899'));
const TAG = String(flag('tag', ''));
const TOKEN = String(flag('token', ''));
const ROOM = String(flag('room', ''));
const OUT = path.resolve(String(flag('out', path.join(REPO, 'docs', 'screenshots'))));
const WIDTH = Number(flag('width', 1440));
const HEIGHT = Number(flag('height', 960));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = [];

async function findTarget() {
  for (let i = 0; i < 24; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* 浏览器还没起来 */
    }
    await sleep(500);
  }
  throw new Error(`连不上调试端口 ${CDP_PORT}`);
}

if (flag('launch', false)) {
  const browser =
    [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : '',
    ].find((p) => p && fs.existsSync(p)) ?? '';
  if (!browser) throw new Error('没找到 Edge / Chrome');
  spawn(
    browser,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${path.join(process.env.TEMP ?? '.', `agenthub-shot-${Date.now().toString(36)}`)}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      `--window-size=${WIDTH},${HEIGHT}`,
      'about:blank',
    ],
    { detached: true, stdio: 'ignore', windowsHide: true },
  ).unref();
  await sleep(2500);
}

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let msgId = 0;
await new Promise((resolve, reject) => {
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
const send = (method, params = {}, timeoutMs = 30_000) =>
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

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return res.result?.result?.value;
};

const waitFor = async (expression, { timeoutMs = 20_000, label = expression } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await evaluate(expression).catch(() => false);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(300);
  }
};

const setValue = (selector, value) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

const clickSelector = (selector) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);

const clickText = (text) =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll('button, a')].reverse().find((n) => (n.textContent || '').includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);

/** Radix 的 Tabs 用 mousedown 激活 */
const clickTab = (prefix) =>
  evaluate(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => (t.textContent || '').trim().startsWith(${JSON.stringify(prefix)}));
    if (!tab) return false;
    for (const type of ['mousedown', 'mouseup', 'click']) tab.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`);

const shoot = async (name) => {
  fs.mkdirSync(OUT, { recursive: true });
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(res.result.data, 'base64'));
  shots.push(name);
  console.log(`  截图 ${name}.png`);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

console.log(`\n=== 采集截图 ===\n应用：${APP}\n输出：${OUT}\n`);

await send('Page.navigate', { url: APP });
await sleep(2500);
await waitFor(`document.body.innerText.includes('进入群聊')`, { label: '登录页' });
await shoot('01-login');

if (TAG && TOKEN) {
  // 用 token 登录（走真实登录表单）
  await clickTab('用 token 登录');
  await sleep(400);
  await setValue('#login-tag-2', TAG);
  await setValue('#login-token', TOKEN);
  await clickText('登录');
  await waitFor(`!document.body.innerText.includes('进入群聊')`, { label: '登录完成' });
} else {
  console.log('  （未提供 --tag/--token，只截登录页）');
}

if (ROOM) {
  await waitFor(`document.body.innerText.includes(${JSON.stringify(ROOM)})`, { label: '房间列表' });
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes(${JSON.stringify(ROOM)}));
    if (btn) btn.click();
    return Boolean(btn);
  })()`);
}
await sleep(2500);
await shoot('02-chat');

await clickTab('文件');
await sleep(800);
await shoot('03-files');

await clickTab('AI');
await sleep(800);
await shoot('04-agents-panel');

// 图片大图预览：点消息里的缩略图
const clickedImage = await evaluate(`(() => {
  const img = document.querySelector('img[src*="/api/files/"]');
  if (!img) return false;
  const clickable = img.closest('button') || img.parentElement;
  clickable.click();
  return true;
})()`);
if (clickedImage) {
  await sleep(1200);
  await shoot('07-image-lightbox');
  await evaluate(`(() => { const btn = document.querySelector('[role="dialog"] button'); if (btn) btn.click(); })()`);
  await sleep(600);
}

// AI 成员页
await clickText('AI 成员');
await sleep(2000);
await shoot('05-agents-page');

// 设置页
await clickText('设置');
await sleep(1200);
await shoot('06-settings');

// 暗色主题
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => (b.title || '') === '切换主题');
  if (btn) btn.click();
  return Boolean(btn);
})()`);
await sleep(1000);
await evaluate(`(() => { const a = [...document.querySelectorAll('a')].find((n) => (n.textContent || '').includes('群聊')); if (a) a.click(); })()`);
await sleep(1500);
await shoot('08-theme-dark');

ws.close();
console.log(`\n完成，共 ${shots.length} 张：${shots.join('、')}\n`);
