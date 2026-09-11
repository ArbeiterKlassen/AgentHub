#!/usr/bin/env node
/**
 * AgentHub 服务守护进程：跑 dist/index.js，崩了/被杀掉自动拉起来。
 *
 *   node scripts/serve-forever.mjs                 # 前台守护（Ctrl+C 退出）
 *   node scripts/serve-forever.mjs --detach        # 以后台方式启动守护进程本身
 *   node scripts/serve-forever.mjs --max-restarts 20
 *
 * 为什么需要：服务是团队频道的实时通道，挂掉期间所有人（含 AI）都发不出消息、界面也拉不到数据；
 * 之前一次重启因为健康检查超时留下了一个"死了没人管"的空档，这个脚本负责兜住这种情况。
 *
 * 日志：
 *   logs/serve-forever.log  守护进程自己的日志（启动/退出/重启原因）
 *   logs/server.out.log     服务 stdout（启动横幅等）
 *   logs/server.err.log     服务 stderr
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(REPO, 'logs');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const PORT = Number(process.env.AH_PORT ?? 8787);
/** 启用了 HTTPS（AH_TLS_CERT）时，本机健康检查也要走 https，并跳过自签证书校验 */
const TLS = Boolean(process.env.AH_TLS_CERT && process.env.AH_TLS_KEY);
const SCHEME = TLS ? 'https' : 'http';
if (TLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const MAX_RESTARTS = Number(flag('max-restarts', 50));
const DETACH = Boolean(flag('detach', false));

fs.mkdirSync(LOG_DIR, { recursive: true });

const logFile = path.join(LOG_DIR, 'serve-forever.log');
const outFile = path.join(LOG_DIR, 'server.out.log');
const errFile = path.join(LOG_DIR, 'server.err.log');
const pidFile = path.join(LOG_DIR, 'serve-forever.pid');

const log = (msg) => {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logFile, `${line}\n`, 'utf8');
};

if (DETACH) {
  // 把自己重新拉成后台进程（cmd 的 start /b 等价物），然后立刻退出
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), ...argv.filter((a) => a !== '--detach')],
    { cwd: REPO, detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  console.log(`守护进程已后台启动（PID ${child.pid}），日志：logs/serve-forever.log`);
  process.exit(0);
}

fs.writeFileSync(pidFile, String(process.pid), 'utf8');
log(`守护进程启动（PID ${process.pid}，端口 ${PORT}，最多重启 ${MAX_RESTARTS} 次）`);

let child = null;
let restarts = 0;
let stopping = false;
let lastExitAt = 0;
let lastStartAt = 0;

async function healthOk(timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SCHEME}://127.0.0.1:${PORT}/api/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function startChild() {
  const out = fs.openSync(outFile, 'a');
  const err = fs.openSync(errFile, 'a');
  child = spawn(process.execPath, ['dist/index.js'], {
    cwd: path.join(REPO, 'server'),
    stdio: ['ignore', out, err],
    windowsHide: true,
    env: { ...process.env, AH_PORT: String(PORT) },
  });
  log(`已启动服务子进程 PID ${child.pid}`);
  lastStartAt = Date.now();

  child.on('exit', (code, signal) => {
    if (stopping) return;
    lastExitAt = Date.now();
    const upSeconds = child?.__startedAt ? Math.round((Date.now() - child.__startedAt) / 1000) : 0;
    log(`⚠️ 服务进程退出（code=${code}, signal=${signal ?? '-'}，存活 ${upSeconds}s）`);
    if (restarts >= MAX_RESTARTS) {
      log(`已达到最大重启次数（${MAX_RESTARTS}），守护进程退出`);
      process.exit(1);
    }
    restarts += 1;
    const delay = upSeconds > 60 ? 1000 : Math.min(1000 * restarts, 10_000);
    log(`${delay}ms 后第 ${restarts} 次重启…`);
    setTimeout(startChild, delay);
  });
  child.__startedAt = Date.now();
}

// 健康巡检：子进程活着但健康检查连续失败时，只记录（不轻易杀），因为可能只是启动中
let healthFails = 0;
setInterval(async () => {
  if (stopping) return;
  // 刚启动的 15 秒内跳过健康检查：进程还在初始化，这时报"失败"只会误导
  if (Date.now() - lastStartAt < 15_000) return;
  const ok = await healthOk();
  if (ok) {
    healthFails = 0;
    return;
  }
  healthFails += 1;
  log(`健康检查失败第 ${healthFails} 次（子进程 ${child?.pid ?? '-'}，存活状态 ${child && !child.killed ? 'running' : 'exited'}）`);
  // 连续 3 次失败且端口没人监听 → 说明进程虽在但没在服务（或已被外部杀掉但没触发 exit）
  if (healthFails >= 3) {
    log('连续 3 次健康检查失败，主动重启子进程');
    healthFails = 0;
    try {
      child?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}, 30_000).unref();

function shutdown(signal) {
  stopping = true;
  log(`收到 ${signal}，正在停止服务子进程并退出`);
  try {
    child?.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      child?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    process.exit(0);
  }, 1500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => {
  try {
    fs.rmSync(pidFile, { force: true });
  } catch {
    /* ignore */
  }
});

startChild();
