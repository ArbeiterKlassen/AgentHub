#!/usr/bin/env node
/**
 * 真浏览器自检：@全体 候选/发送 与 昼夜模式过渡动画（CDP 驱动 Edge/Chrome）。
 *
 *   node scripts/verify-ui-polish.mjs --launch --app http://127.0.0.1:8793
 *
 * 覆盖：
 *   1) 输入 @ 时候选里出现「全体成员 @all」，点击后写入 @all
 *   2) 发送 @all 后 3 个 AI 都回帖，且消息里的 @all 渲染成群发样式（.mention-chip-all）
 *   3) 主题切换是插值过渡：切换瞬间 <html> 带 .theme-transition，
 *      body 背景色在过渡中途严格介于浅色与深色之间，400ms 后过渡类自动移除
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

const PORT = Number(flag('port', 9231));
const APP = String(flag('app', process.env.AH_APP ?? 'http://127.0.0.1:8793')).replace(/\/+$/, '');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(REPO, 'docs', 'screenshots');
const RUN = Date.now().toString(36).slice(-4);

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
}

async function api(pathname, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${APP}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

async function findTarget() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* 浏览器还没起来 */
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
  return { ws, send, ready };
}

const AGENTS = [`ui-a-${RUN}`, `ui-b-${RUN}`, `ui-c-${RUN}`];
let ROOM = `ui-all-${RUN}`;

async function setupData() {
  const me = `ui-human-${RUN}`;
  const human = await api('/api/register', { method: 'POST', body: { tag: me, nickname: 'UI 检查员' } });
  if (!human.ok) throw new Error(`注册人类失败：${JSON.stringify(human.data)}`);
  for (const [i, tag] of AGENTS.entries()) {
    const res = await api('/api/register', {
      method: 'POST',
      body: { tag, nickname: `UI 模拟 AI ${i + 1}`, kind: 'agent', adapterId: 'mock', agentKind: 'mock' },
    });
    if (!res.ok) throw new Error(`注册 AI ${tag} 失败：${JSON.stringify(res.data)}`);
  }
  const room = await api('/api/rooms', {
    method: 'POST',
    token: human.data.token,
    body: { name: ROOM, topic: '@全体 UI 自检', members: AGENTS },
  });
  if (!room.ok) throw new Error(`建房失败：${JSON.stringify(room.data)}`);
  return { token: human.data.token, member: human.data.member };
}

async function main() {
  console.log(`\n=== UI 自检：@全体 + 主题过渡 ===\n应用：${APP}\n房间：${ROOM}\n`);
  const { token, member } = await setupData();
  check('准备数据：3 个 mock AI + 1 个人类在同一房间', true, ROOM);

  if (flag('launch')) {
    const browser =
      [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : '',
      ].find((p) => p && fs.existsSync(p)) ?? '';
    if (!browser) throw new Error('没找到 Edge/Chrome');
    const profile = path.join(process.env.TEMP ?? '.', `agenthub-ui-polish-${RUN}`);
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text);
    return res.result?.result?.value;
  };
  const screenshot = async (name) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const res = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOT_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(res.result.data, 'base64'));
    console.log(`     截图 → ${path.relative(REPO, file)}`);
    return file;
  };
  const waitFor = async (expression, { timeoutMs = 20000, label = expression } = {}) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await evaluate(expression).catch(() => false);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
      await sleep(250);
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

  /* 注入登录态：session 直接写持久化 store，theme 先浅色 */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try {
      localStorage.setItem('agenthub-session', ${JSON.stringify(
        JSON.stringify({ state: { server: '', token, member }, version: 1 }),
      )});
      localStorage.setItem('agenthub-ui', ${JSON.stringify(
        JSON.stringify({ state: { theme: 'light', rightPanelOpen: true }, version: 1 }),
      )});
    } catch (e) {}`,
  });

  await send('Page.navigate', { url: `${APP}/` });
  await waitFor(`!!document.querySelector('textarea')`, { label: '进入群聊页并加载输入框' });
  check('前端加载并进入房间（输入框可用）', true);

  /* 1. @ 候选含「全体成员 @all」 */
  await setValue('textarea', '@');
  const pickerText = await waitFor(
    `(() => {
      const box = document.querySelector('.absolute.bottom-full');
      return box && box.textContent.includes('全体成员') ? box.textContent : '';
    })()`,
    { timeoutMs: 5000, label: '@ 候选里出现全体成员' },
  );
  check('@ 候选第一项是「全体成员 @all」', pickerText.includes('@all'), pickerText.replace(/\s+/g, ' ').slice(0, 60));
  await screenshot('ui-verify-at-all-picker');

  const clicked = await evaluate(`(() => {
    const box = document.querySelector('.absolute.bottom-full');
    const btn = box && [...box.querySelectorAll('button')].find((b) => b.textContent.includes('@all'));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  const afterPick = await evaluate(`document.querySelector('textarea').value`);
  check('点击候选后写入 @all', clicked && afterPick.trim() === '@all', JSON.stringify(afterPick));

  /* 2. 发送 @all，3 个 AI 都应回帖，消息里的 @all 是群发样式 */
  const before = await evaluate(`document.querySelectorAll('.bubble-other').length`);
  await setValue('textarea', '@all 全体 UI 自检，收到请回一句');
  await evaluate(`document.querySelector('button[title^="发送"]').click()`);
  const ownChip = await waitFor(
    `document.querySelectorAll('.bubble-own .mention-chip-all').length`,
    { timeoutMs: 5000, label: '自己气泡里的 @all 群发样式' },
  );
  check('消息里的 @all 渲染成群发样式', ownChip >= 1, `.mention-chip-all × ${ownChip}`);
  const replied = await waitFor(
    `document.querySelectorAll('.bubble-other').length >= ${before + AGENTS.length}`,
    { timeoutMs: 30000, label: `等待 ${AGENTS.length} 个 AI 回帖` },
  );
  const afterCount = await evaluate(`document.querySelectorAll('.bubble-other').length`);
  check('@all 让 3 个 AI 全部回帖（UI 侧可见）', Boolean(replied), `气泡 ${before} → ${afterCount}`);
  await screenshot('ui-verify-mention-all');

  /* 3. 主题过渡 */
  const themeState = await evaluate(`(() => {
    const btn = document.querySelector('button[title="切换主题"]');
    if (!btn) return { ok: false };
    return {
      ok: true,
      darkBefore: document.documentElement.classList.contains('dark'),
      bgBefore: getComputedStyle(document.body).backgroundColor,
    };
  })()`);
  check('找到主题切换按钮', themeState.ok, `切换前 dark=${themeState.darkBefore}`);

  await evaluate(`document.querySelector('button[title="切换主题"]').click()`);
  const samples = [];
  for (let i = 0; i < 12; i += 1) {
    samples.push(
      await evaluate(`({
        t: performance.now(),
        cls: document.documentElement.classList.contains('theme-transition'),
        bg: getComputedStyle(document.body).backgroundColor,
        dur: getComputedStyle(document.body).transitionDuration,
      })`),
    );
    if (i === 2) await screenshot('ui-verify-theme-mid-transition');
    await sleep(40);
  }

  const parseRgb = (s) => (s.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  const dark = themeState.darkBefore === false;
  // 目标色：浅色白底 → 深色 222 47% 4%（≈ #060910）
  const to = dark ? [6, 9, 16] : [255, 255, 255];
  const from = dark ? [255, 255, 255] : [6, 9, 16];
  const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const mid = samples
    .map((s) => parseRgb(s.bg))
    .filter((rgb) => rgb.length === 3)
    .find((rgb) => {
      const v = lum(rgb);
      return v > Math.min(lum(from), lum(to)) + 8 && v < Math.max(lum(from), lum(to)) - 8;
    });
  check('过渡类在切换瞬间生效', samples[0]?.cls === true, `first cls=${samples[0]?.cls}`);
  check(
    '整页颜色在过渡中途处于两端之间（真的在插值）',
    Boolean(mid),
    mid ? `采样到 rgb(${mid.join(',')})；起 rgb(${from.join(',')}) 终 rgb(${to.join(',')})` : JSON.stringify(samples.slice(0, 3)),
  );
  check(
    'transitionDuration 非 0（存在动画）',
    samples.some((s) => s.dur && s.dur !== '0s'),
    samples.find((s) => s.dur && s.dur !== '0s')?.dur ?? 'n/a',
  );

  await sleep(600);
  const settled = await evaluate(`({
    cls: document.documentElement.classList.contains('theme-transition'),
    dark: document.documentElement.classList.contains('dark'),
    scheme: document.documentElement.style.colorScheme,
    bg: getComputedStyle(document.body).backgroundColor,
  })`);
  check('过渡结束后自动移除过渡类', settled.cls === false);
  check('主题已切到深色且原生控件配色同步', settled.dark === true && settled.scheme === 'dark', settled.bg);
  await screenshot('ui-verify-theme-dark');

  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n通过 ${results.length - failed.length}/${results.length} 项` +
      (failed.length ? `\n未通过：${failed.map((f) => f.name).join('、')}` : '\n全部通过 ✅'),
  );
  client.ws.close();
  return failed.length;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  check(`执行中断：${err.message}`, false);
  code = 1;
}
process.exit(code);
