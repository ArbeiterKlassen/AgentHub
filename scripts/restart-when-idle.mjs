#!/usr/bin/env node
/**
 * 空闲即重启 AgentHub 服务（用于让「已编译但未生效」的修复上线，又不打断正在跑的 AI 任务）。
 *
 *   node scripts/restart-when-idle.mjs                 # 等到没有在跑的 AI 任务时自动重启
 *   node scripts/restart-when-idle.mjs --force         # 立刻重启（会中断正在跑的 AI 任务）
 *   node scripts/restart-when-idle.mjs --max-wait 45   # 最长等待分钟数，超时就放弃
 *   node scripts/restart-when-idle.mjs --port 8787
 *
 * 判定「在跑」的口径与界面一致：agent_runs 里 status='running' 且创建时间在 15 分钟内
 * （更早的 running 记录属于历史遗留/僵尸，不会阻塞重启）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const PORT = Number(flag('port', process.env.AH_PORT ?? 8787));
/** 服务可能跑在 https（自签证书）上：本机健康检查与自检子进程都要跟着换协议 */
const TLS = Boolean(process.env.AH_TLS_CERT && process.env.AH_TLS_KEY);
const SCHEME = TLS ? 'https' : 'http';
if (TLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const FORCE = Boolean(flag('force', false));
const MAX_WAIT_MS = Number(flag('max-wait', 45)) * 60 * 1000;
const DATA_DIR = process.env.AH_DATA_DIR ?? path.join(REPO, 'data');
const LOG_DIR = path.join(REPO, 'logs');
const STALE_MS = 15 * 60 * 1000;

fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, 'restart-when-idle.log');
const log = (msg) => {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logFile, `${line}\n`, 'utf8');
};

function liveRuns() {
  const db = new DatabaseSync(path.join(DATA_DIR, 'agenthub.db'), { readOnly: true });
  const rows = db
    .prepare("SELECT agent_tag, trigger_msg, created_at FROM agent_runs WHERE status='running'")
    .all();
  db.close();
  return rows.filter((r) => Date.now() - r.created_at <= STALE_MS);
}

function pidsOnPort(port) {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ','`,
      ],
      { encoding: 'utf8' },
    );
    return out.trim().split(',').map((s) => Number(s.trim())).filter(Boolean);
  } catch {
    return [];
  }
}

async function healthOk(timeoutMs = 2500) {
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

async function restart() {
  log(`准备重启 8787 上的服务（端口 ${PORT}）…`);
  const pids = pidsOnPort(PORT);
  if (!pids.length) {
    log('端口上没有监听进程，直接启动新实例');
  }
  for (const pid of pids) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      log(`已停止进程 PID ${pid}`);
    } catch (err) {
      log(`停止 PID ${pid} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await new Promise((r) => setTimeout(r, 2000));

  const outLog = path.join(LOG_DIR, 'server-prod.out.log');
  const errLog = path.join(LOG_DIR, 'server-prod.err.log');
  spawn(
    'cmd.exe',
    ['/c', `node dist/index.js > "${outLog}" 2> "${errLog}"`],
    { cwd: path.join(REPO, 'server'), detached: true, stdio: 'ignore', windowsHide: true },
  ).unref();

  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await healthOk()) {
      log(`✅ 服务已重启并响应健康检查：${SCHEME}://127.0.0.1:${PORT}`);
      // 顺手跑一遍端到端自检，把「修复是否真的生效」写进日志
      log('开始跑端到端自检（node scripts/e2e-test.mjs）…');
      const summary = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(REPO, 'scripts', 'e2e-test.mjs')], {
          cwd: REPO,
          windowsHide: true,
          env: {
            ...process.env,
            NO_COLOR: '1',
            AH_SERVER: `${SCHEME}://127.0.0.1:${PORT}`,
            ...(TLS ? { AH_INSECURE: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0' } : {}),
          },
        });
        let out = '';
        child.stdout.on('data', (d) => (out += String(d)));
        child.stderr.on('data', (d) => (out += String(d)));
        child.on('close', (code) => resolve({ code, out }));
      });
      const lines = summary.out.split(/\r?\n/).filter(Boolean);
      const failed = lines.filter((l) => l.includes('FAIL'));
      log(`自检结束：退出码 ${summary.code}｜${lines.at(-2) ?? ''}｜${lines.at(-1) ?? ''}`);
      for (const line of failed) log(`  ${line.trim()}`);
      return true;
    }
  }
  log('❌ 重启后健康检查未通过，请查看 logs/server-prod.err.log');
  try {
    log(`err.log 末尾：${fs.readFileSync(errLog, 'utf8').split(/\r?\n/).slice(-6).join(' | ')}`);
  } catch {
    /* ignore */
  }
  return false;
}

if (FORCE) {
  await restart();
  process.exit(0);
}

log(`开始等待空闲窗口（最长 ${Math.round(MAX_WAIT_MS / 60000)} 分钟）…`);
const startedAt = Date.now();
let idleStreak = 0;

for (;;) {
  const live = liveRuns();
  if (!live.length) {
    idleStreak += 1;
    if (idleStreak >= 2) {
      log('连续两次检查都没有在跑的 AI 任务，开始重启');
      const ok = await restart();
      process.exit(ok ? 0 : 1);
    }
  } else {
    idleStreak = 0;
    if ((Date.now() - startedAt) % 60000 < 10000) {
      log(
        `仍在跑：${live
          .map((r) => `@${r.agent_tag}(#${r.trigger_msg}, ${Math.round((Date.now() - r.created_at) / 1000)}s)`)
          .join(' ')}`,
      );
    }
  }
  if (Date.now() - startedAt > MAX_WAIT_MS) {
    log('等待超时，未执行重启（修复仍在 dist 里，手动跑 --force 即可生效）');
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
