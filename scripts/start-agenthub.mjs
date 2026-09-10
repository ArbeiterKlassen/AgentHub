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
const PORT = Number(process.env.AH_PORT ?? 8787);
const URL = `http://127.0.0.1:${PORT}`;

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
    const res = await fetch(`${URL}/api/health`, { signal: controller.signal });
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
    spawn('cmd.exe', ['/c', 'start', '', URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* 打不开浏览器不影响服务 */
  }
}

// 1. 已经在跑：只开网页，不重复启动（否则两个进程抢 8787）
if (await healthOk()) {
  console.log(c.yellow('  [提示] 服务已经在运行了，这次只帮你打开网页。'));
  console.log(c.dim(`         ${URL}`));
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

// 3. 前台运行守护进程：Ctrl+C 即可停止
console.log(`  服务地址   ${c.cyan(URL)}`);
console.log(`  ${c.yellow('停止服务')}   在这个窗口按 Ctrl+C`);
console.log(`  ${c.yellow('关闭窗口')}   直接点右上角 X（等于停止服务）`);
console.log('');
console.log(c.dim('  正在启动，约 5 秒后自动打开浏览器…'));
console.log('');

setTimeout(openBrowser, 5000);

await import('./serve-forever.mjs');
