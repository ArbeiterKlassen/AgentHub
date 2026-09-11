#!/usr/bin/env node
/**
 * Cloudflare Tunnel 启动器（由 start-tunnel.bat 调用；bat 只放 ASCII，中文都从这里输出）。
 *
 * 做四件事：
 *   1. 找到 cloudflared（CLOUDFLARED 环境变量 → PATH → <repo>\..\tools\cloudflared\）
 *   2. 读隧道配置里的 service 行，知道它期望的源协议（https 还是 http）
 *   3. 预检本机 AgentHub：不通就自动另开窗口拉起服务；协议对不上就明确告诉你怎么改
 *      （这正是「服务跑 HTTP、隧道配 HTTPS → CF 502」那个坑）
 *   4. 前台运行 cloudflared，并把输出同时写进 logs/tunnel.out.log（Ctrl+C 停止）
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(REPO, 'logs');
const TUNNEL_LOG = path.join(LOG_DIR, 'tunnel.out.log');
const CONFIG = path.join(REPO, 'data', 'cloudflared', 'config.yml');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const NO_AUTOSTART = Boolean(flag('no-autostart', false));
const KEEP_LOG = Boolean(flag('keep-log', false));

const c = {
  cyan: (t) => `\u001b[36m${t}\u001b[0m`,
  green: (t) => `\u001b[32m${t}\u001b[0m`,
  yellow: (t) => `\u001b[33m${t}\u001b[0m`,
  red: (t) => `\u001b[31m${t}\u001b[0m`,
  dim: (t) => `\u001b[2m${t}\u001b[0m`,
};

console.log('');
console.log(c.cyan('  =========================================='));
console.log('    AgentHub · Cloudflare Tunnel');
console.log(c.cyan('  =========================================='));
console.log('');

/* 1. 找 cloudflared */
const findCloudflared = () => {
  const candidates = [
    process.env.CLOUDFLARED,
    'cloudflared', // PATH
    path.join(REPO, '..', 'tools', 'cloudflared', 'cloudflared.exe'),
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  ].filter(Boolean);
  for (const bin of candidates) {
    if (bin !== 'cloudflared' && !fs.existsSync(bin)) continue;
    try {
      execFileSync(bin, ['--version'], { stdio: 'pipe', windowsHide: true, timeout: 10_000 });
      return bin;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
};
const CF = findCloudflared();
if (!CF) {
  console.error(c.red('  [错误] 找不到 cloudflared。'));
  console.error(c.dim('         装一个：winget install Cloudflare.cloudflared'));
  console.error(c.dim('         或下载 exe 后设置环境变量 CLOUDFLARED=<路径>'));
  process.exit(1);
}

/* 2. 读配置里的 origin service */
if (!fs.existsSync(CONFIG)) {
  console.error(c.red(`  [错误] 找不到隧道配置：${CONFIG}`));
  console.error(c.dim('         可从 docs/cloudflare-tunnel.example.yml 复制一份改好。'));
  process.exit(1);
}
const configText = fs.readFileSync(CONFIG, 'utf8');
const serviceLine = configText.split(/\r?\n/).find((l) => /^\s*service:\s*\S+/.test(l)) ?? '';
const serviceUrl = (serviceLine.split('service:')[1] ?? '').trim();
const wantScheme = serviceUrl.startsWith('http://') ? 'http' : serviceUrl.startsWith('https://') ? 'https' : '?';
const hostPort = (serviceUrl.match(/https?:\/\/([^/\s]+)/) ?? [])[1] ?? '127.0.0.1:8787';
console.log(`  隧道配置   ${path.relative(REPO, CONFIG)}`);
console.log(`  源地址     ${c.cyan(serviceUrl)}`);
console.log('');

/* 3. 预检本机服务 */
async function probe(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

if (wantScheme === 'https' || wantScheme === 'http') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // 本机自签证书，预检不需要校验
}
const originUrl = `http://${hostPort}/api/health`;
const originUrlTls = `https://${hostPort}/api/health`;

let liveScheme = null;
if (await probe(originUrlTls)) liveScheme = 'https';
else if (await probe(originUrl)) liveScheme = 'http';

if (!liveScheme) {
  console.log(c.yellow('  [提示] 本机 AgentHub 服务没在跑（8787 无响应）。'));
  if (NO_AUTOSTART) {
    console.error(c.red('  [错误] 已指定 --no-autostart，先启动服务再跑隧道。'));
    process.exit(1);
  }
  console.log(c.dim('         正在另开一个窗口启动它（就是桌面上那个 AgentHub 图标做的事）…'));
  spawn('cmd.exe', ['/c', 'start', '', path.join(REPO, 'start-agenthub.bat')], {
    cwd: REPO,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();

  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && !liveScheme) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await probe(originUrlTls, 2500)) liveScheme = 'https';
    else if (await probe(originUrl, 2500)) liveScheme = 'http';
  }
  if (!liveScheme) {
    console.error(c.red('  [错误] 40 秒内服务仍未起来，先看那个窗口的报错（或 logs/serve-forever.log）。'));
    process.exit(1);
  }
  console.log(c.green(`  [OK] 服务已起来（${liveScheme}）。`));
  console.log('');
}

if (liveScheme !== wantScheme) {
  console.log('');
  console.log(c.red(`  [协议不匹配] 隧道配置要求 ${wantScheme.toUpperCase()}，但本机服务实际是 ${liveScheme.toUpperCase()}。`));
  console.log(c.dim('               这样 Cloudflare 会返回 502。二选一：'));
  if (wantScheme === 'https') {
    console.log(c.dim('               A) 用 HTTPS 重启服务：关掉服务窗口，然后双击桌面 AgentHub 图标（已装证书会自动用 HTTPS）'));
    console.log(c.dim('               B) 或者把隧道配置的 service 改成 http://' + hostPort));
  } else {
    console.log(c.dim('               A) 用 HTTP 重启服务：start-agenthub.bat --http'));
    console.log(c.dim('               B) 或者把隧道配置的 service 改成 https://' + hostPort));
  }
  console.log('');
  process.exit(2);
}

console.log(c.green(`  [OK] 预检通过：本机服务以 ${liveScheme.toUpperCase()} 正常响应。`));
console.log('');
console.log(`  公网访问   ${c.cyan('https://agenthub.soyorin.work')}`);
console.log(`  ${c.yellow('停止隧道')}   在这个窗口按 Ctrl+C`);
console.log('');

/* 4. 前台跑 cloudflared，输出同时落盘 */
fs.mkdirSync(LOG_DIR, { recursive: true });
if (!KEEP_LOG) fs.writeFileSync(TUNNEL_LOG, `# ${new Date().toLocaleString('zh-CN')} 启动\n`, 'utf8');
const logStream = fs.createWriteStream(TUNNEL_LOG, { flags: 'a' });

const child = spawn(CF, ['--config', CONFIG, 'tunnel', 'run'], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false,
});
const relay = (chunk, isErr) => {
  const text = String(chunk);
  logStream.write(text);
  if (isErr) process.stderr.write(text);
  else process.stdout.write(text);
};
child.stdout.on('data', (d) => relay(d, false));
child.stderr.on('data', (d) => relay(d, true));
child.on('close', (code) => {
  logStream.end();
  console.log('');
  console.log(`  [隧道已退出] 退出码 ${code}；完整日志：logs/tunnel.out.log`);
  process.exit(code ?? 0);
});

const stop = () => {
  console.log('\n  正在停止隧道…');
  try {
    child.kill('SIGINT');
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
