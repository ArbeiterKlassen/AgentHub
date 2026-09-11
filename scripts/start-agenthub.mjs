#!/usr/bin/env node
/**
 * 桌面图标用的启动器：检查环境 → 判断服务是否已在跑 → 打开浏览器 → 前台运行守护进程。
 *
 * 由 start-agenthub.bat 调用（bat 里只放 ASCII，中文提示都由这里输出，避免 cmd 用 OEM 代码页把 bat 解析坏）。
 * 前台运行意味着：**在这个窗口按 Ctrl+C 就能停服**；直接关窗口同样会停（子进程随父进程退出）。
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
const PORT = Number(process.env.AH_PORT ?? 8787);
/**
 * 协议选择：
 *   --http            强制明文 HTTP（内网穿透自带 TLS 时用）
 *   --https           强制 HTTPS（证书不存在会现场生成）
 *   都没给            有证书就用 HTTPS，没证书就用 HTTP
 * 这样「桌面图标」与「Cloudflare Tunnel 的 https 源」默认就是一致的，不会再出现
 * 服务跑 HTTP、隧道按 HTTPS 连 → 502 这种坑。
 */
const FORCE_HTTP = Boolean(flag('http', false));
const TLS_DIR = path.join(process.env.AH_DATA_DIR ?? path.join(REPO, 'data'), 'tls');
const CERT_FILE = path.join(TLS_DIR, 'cert.pem');
const KEY_FILE = path.join(TLS_DIR, 'key.pem');
const CERT_EXISTS = fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
const EXPLICIT_HTTPS = Boolean(flag('https', false));
const WANT_HTTPS = FORCE_HTTP ? false : EXPLICIT_HTTPS || Boolean(process.env.AH_TLS_CERT) || CERT_EXISTS;
let SCHEME = WANT_HTTPS ? 'https' : 'http';
const URL = () => `${SCHEME}://127.0.0.1:${PORT}`;

const c = {
  cyan: (t) => `\u001b[36m${t}\u001b[0m`,
  green: (t) => `\u001b[32m${t}\u001b[0m`,
  yellow: (t) => `\u001b[33m${t}\u001b[0m`,
  red: (t) => `\u001b[31m${t}\u001b[0m`,
  dim: (t) => `\u001b[2m${t}\u001b[0m`,
};

console.log('');
console.log(c.cyan('  =========================================='));
console.log('    AgentHub · 人机群聊服务');
console.log(c.cyan('  =========================================='));
console.log('');

async function healthOk(timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${URL()}/api/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function openBrowser() {
  if (process.env.AH_NO_BROWSER === '1') return;
  try {
  spawn('cmd.exe', ['/c', 'start', '', URL()], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* 打不开浏览器不影响服务 */
  }
}

// 1. 已经在跑：只开网页，不重复启动（否则两个进程抢 8787）
if (await healthOk()) {
  console.log(c.yellow('  [提示] 服务已经在运行了，这次只帮你打开网页。'));
  console.log(c.dim(`         ${URL()}`));
  console.log(c.dim('         要停止服务，请在它自己的窗口里按 Ctrl+C。'));
  console.log('');
  openBrowser();
  process.exit(0);
}

// 2. 后端没构建过就先构建
if (!fs.existsSync(path.join(REPO, 'server', 'dist', 'index.js'))) {
  console.log(c.yellow('  [提示] 还没构建过后端，正在构建（只需一次，约 10 秒）…'));
  const code = await new Promise((resolve) => {
    const child = spawn('npm', ['run', 'build'], {
      cwd: path.join(REPO, 'server'),
      stdio: 'inherit',
      shell: true,
      windowsHide: true,
    });
    child.on('close', (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0 || !fs.existsSync(path.join(REPO, 'server', 'dist', 'index.js'))) {
    console.error(c.red('  [错误] 构建失败。请手动执行：npm --prefix server run build'));
    process.exit(1);
  }
  console.log(c.green('  [完成] 后端已构建。'));
  console.log('');
}

// 2.5 要 HTTPS 就确保证书存在（没有就现场生成一张自签的）
if (WANT_HTTPS) {
  if (!CERT_EXISTS) {
    console.log(c.yellow('  [提示] 还没有 HTTPS 证书，正在生成自签证书（有效期 3 年）…'));
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(REPO, 'scripts', 'make-cert.mjs')], {
        cwd: REPO,
        stdio: 'inherit',
        windowsHide: true,
      });
      child.on('close', (exitCode) => resolve(exitCode ?? 1));
    });
    if (code !== 0) {
      console.error(c.red('  [错误] 证书生成失败，改用 HTTP 启动。'));
      SCHEME = 'http';
    }
  }
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    process.env.AH_TLS_CERT = CERT_FILE;
    process.env.AH_TLS_KEY = KEY_FILE;
    // 自签证书，本机自检不需要校验证书链
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.log(c.green('  [HTTPS] 已启用自签证书；手机首次打开会提示「不安全」，点继续即可。'));
    console.log(c.dim(`         想让提示消失：把 ${CERT_FILE} 装到手机的受信任凭据里。`));
    console.log(c.dim('         想改用明文 HTTP：start-agenthub.bat --http'));
    console.log('');
  } else {
    console.log(c.yellow('  [提示] 未找到证书，按 HTTP 启动。'));
  }
}

// 3. 前台运行守护进程：Ctrl+C 即可停止
console.log(`  服务地址   ${c.cyan(URL())}`);
console.log(c.dim(`  启动模式   ${SCHEME.toUpperCase()}${WANT_HTTPS && CERT_EXISTS && !EXPLICIT_HTTPS ? '（检测到证书自动选择；加 --http 可强制明文）' : ''}`));
console.log(`  ${c.yellow('停止服务')}   在这个窗口按 Ctrl+C`);
console.log(`  ${c.yellow('关闭窗口')}   直接点右上角 X（等于停止服务）`);
console.log('');
console.log(c.dim('  正在启动，约 5 秒后自动打开浏览器…'));
console.log('');

setTimeout(openBrowser, 5000);

await import('./serve-forever.mjs');
