#!/usr/bin/env node
/**
 * 聊天图片预览自检：登录 → 进入指定房间 → 用输入框的文件按钮上传一张图片 →
 * 断言消息内出现已解码的缩略图 → 点击后能开大图 lightbox → 右侧文件区也有缩略图。
 *
 *   node scripts/verify-image-preview.mjs --image docs/image-preview-selftest.png
 *
 * 注意：会真的往目标房间发一条图片消息（这就是被测行为）。
 */
import fs from 'node:fs';
import os from 'node:os';
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
const SERVER = String(flag('server', 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const PROFILE = String(flag('profile', 'codex-lead'));
const ROOM_NAME = String(flag('room', 'CUMCM Team CHANNEL'));
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = path.resolve(REPO, String(flag('image', 'docs/image-preview-selftest.png')));
const SHOT_DIR = path.join(REPO, 'docs', 'screenshots');
const RUN = Date.now().toString(36).slice(-4);
const IMAGE_NAME = path.basename(IMAGE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass });
  const tag = pass ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  console.log(`${tag} ${name}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`);
}

function readProfile(profile) {
  const file = path.join(os.homedir(), '.agenthub', 'profiles', `${profile}.json`);
  if (!fs.existsSync(file)) throw new Error(`找不到 profile：${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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
  throw new Error(`连不上调试端口 ${PORT}`);
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
  return { send, ready };
}

async function main() {
  if (!fs.existsSync(IMAGE)) throw new Error(`找不到测试图片：${IMAGE}`);

  const profile = readProfile(PROFILE);
  const meRes = await fetch(`${SERVER}/api/me`, { headers: { Authorization: `Bearer ${profile.token}` } });
  if (!meRes.ok) throw new Error(`/api/me 失败：${meRes.status}`);
  const me = await meRes.json();
  const room = (me.rooms ?? []).find((r) => r.name === ROOM_NAME);
  if (!room) throw new Error(`身份 @${me.member.tag} 不在房间「${ROOM_NAME}」里`);
  console.log(`\n=== 聊天图片预览自检 ===\n身份：@${me.member.tag}  房间：${room.name} (${room.id})\n图片：${IMAGE_NAME}\n`);

  const browserPath =
    [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : '',
    ].find((p) => p && fs.existsSync(p)) ?? '';
  if (!browserPath) throw new Error('没找到 Edge/Chrome');
  const userDataDir = path.join(os.tmpdir(), `agenthub-imgverify-${RUN}`);
  spawn(
    browserPath,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--window-size=1440,980',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore', windowsHide: true },
  ).unref();
  await sleep(2500);

  const target = await findTarget();
  const client = createClient(target.webSocketDebuggerUrl);
  await client.ready;
  const { send } = client;
  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text);
    return res.result?.result?.value;
  };
  const waitFor = async (expression, { timeoutMs = 20000, label = expression } = {}) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await evaluate(expression).catch(() => false);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
      await sleep(300);
    }
  };
  const screenshot = async (name) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(SHOT_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(res.result.data, 'base64'));
    console.log(`     截图 → ${path.relative(REPO, file)}`);
    return file;
  };

  // 1. 注入会话并进入房间
  await send('Page.navigate', { url: APP });
  await sleep(2000);
  await evaluate(`localStorage.setItem('agenthub-session', ${JSON.stringify(
    JSON.stringify({ state: { server: SERVER, token: profile.token, member: me.member }, version: 1 }),
  )})`);
  await send('Page.reload');
  await sleep(2500);
  const inRoom = await waitFor(
    `document.body.innerText.includes(${JSON.stringify(ROOM_NAME)}) && Boolean(document.querySelector('textarea'))`,
    { label: '进入房间' },
  )
    .then(() => true)
    .catch(() => false);
  check('用已有身份进入群聊', inRoom);
  if (!inRoom) {
    console.log(`     \u001b[2m页面文本：${String(await evaluate('document.body.innerText')).replace(/\n+/g, ' | ').slice(0, 500)}\u001b[0m`);
    throw new Error('没能进入房间，后续断言跳过');
  }

  // 2. 通过输入框的上传按钮投图（走真实 UI 路径）
  const marked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.title || '').includes('上传文件到共享文件区'));
    const input = btn?.parentElement?.querySelector('input[type=file]');
    if (!input) return false;
    input.setAttribute('data-verify-target', '1');
    return true;
  })()`);
  check('找到输入框的上传按钮', Boolean(marked));
  const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
  const found = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[data-verify-target="1"]' });
  if (!found.result?.nodeId) throw new Error('DOM 里找不到被标记的 file input');
  const described = await send('DOM.describeNode', { nodeId: found.result.nodeId });
  await send('DOM.setFileInputFiles', { files: [IMAGE], backendNodeId: described.result.node.backendNodeId });

  // 3. 断言消息流里的缩略图真的解码成功（naturalWidth>0 才算预览成功）
  const thumb = await waitFor(
    `(() => {
      const img = [...document.querySelectorAll('main img, .thin-scrollbar img, img')]
        .find((n) => n.alt === ${JSON.stringify(IMAGE_NAME)} && n.naturalWidth > 0);
      if (!img) return false;
      return { w: img.naturalWidth, h: img.naturalHeight, box: Math.round(img.getBoundingClientRect().width), src: img.currentSrc.slice(0, 90) };
    })()`,
    { label: '消息内缩略图解码完成' },
  ).catch(() => null);
  check('上传后消息里出现已解码的图片预览', Boolean(thumb), thumb ? `${thumb.w}×${thumb.h} 显示宽 ${thumb.box}px` : '未找到 naturalWidth>0 的 img');
  const chipOnly = await evaluate(
    `[...document.querySelectorAll('a')].some((a) => (a.textContent || '').includes(${JSON.stringify(IMAGE_NAME)}) && a.querySelector('svg'))`,
  );
  check('图片没有被降级成纯下载条目', !chipOnly);
  await screenshot('07-chat-image-preview');

  // 4. 点击缩略图 → 大图 lightbox
  await evaluate(`(() => {
    const img = [...document.querySelectorAll('img')].find((n) => n.alt === ${JSON.stringify(IMAGE_NAME)});
    img?.closest('button')?.click();
    return Boolean(img);
  })()`);
  const box = await waitFor(
    `(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const img = dlg?.querySelector('img');
      if (!img || !img.naturalWidth) return false;
      const r = img.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })()`,
    { timeoutMs: 8000, label: 'lightbox 打开' },
  ).catch(() => null);
  check('点击缩略图能打开大图', Boolean(box), box ? `渲染 ${box.w}×${box.h}px` : '');
  if (box) await screenshot('08-image-lightbox');
  await evaluate(`document.querySelector('[role="dialog"] button')?.click()`);
  await sleep(600);

  // 5. 右侧文件区
  const tabClicked = await evaluate(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => (t.textContent || '').trim().startsWith('文件'));
    if (!tab) return false;
    for (const type of ['mousedown', 'mouseup', 'click']) tab.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`);
  await sleep(900);
  const panelThumb = await evaluate(`(() => {
    const aside = [...document.querySelectorAll('aside')].at(-1);
    const img = aside ? [...aside.querySelectorAll('img')].find((n) => n.alt === ${JSON.stringify(IMAGE_NAME)} && n.naturalWidth > 0) : null;
    return Boolean(img);
  })()`);
  check('右侧「文件」页里的图片也有缩略图', Boolean(panelThumb), tabClicked ? '' : '没找到文件页签');
  if (!panelThumb) {
    const diag = await evaluate(`(() => {
      const aside = [...document.querySelectorAll('aside')].at(-1);
      const imgs = aside ? [...aside.querySelectorAll('img')] : [];
      const panels = [...document.querySelectorAll('[role="tabpanel"]')].map((p) => ({
        hidden: p.getAttribute('data-state'),
        head: (p.textContent || '').trim().slice(0, 60),
      }));
      return {
        asideImgs: imgs.map((n) => ({ alt: n.alt, nw: n.naturalWidth, cls: n.className.slice(0, 60) })).slice(0, 6),
        fileMentioned: aside ? (aside.innerText || '').includes(${JSON.stringify(IMAGE_NAME)}) : false,
        panels,
      };
    })()`);
    console.log(`     \u001b[2m诊断：${JSON.stringify(diag)}\u001b[0m`);
  }
  await screenshot('09-files-panel-image');

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${failed.length ? '\u001b[31m' : '\u001b[32m'}结果：${results.length - failed.length}/${results.length} 通过\u001b[0m\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`\u001b[31m自检中断：${err.message}\u001b[0m`);
  process.exit(1);
});
