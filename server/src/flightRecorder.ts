/**
 * 黑匣子：记下服务进程「最近做了什么」，专门用来追那些不留 JS 堆栈的原生崩溃
 * （退出码 0xC0000005 / 3221225477 —— 访问冲突，进程直接消失，什么日志都来不及写）。
 *
 * 设计上刻意保持极简：
 *   - record() 只往内存环形缓冲里塞一条，几乎零成本，可以到处调；
 *   - 周期性刷盘（默认 2 秒）只在有新记录时写一次，写临时文件再 rename，避免崩溃时留下半截 JSON；
 *   - 真正危险的动作（删房间文件、杀子进程、删库事务）调用 flushNow() 立刻落盘，
 *     这样崩溃后文件里最后一条就是「正要做什么」。
 * 守护进程（serve-forever）在子进程非正常退出时会把这个文件的后几条打进日志。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './env.js';

const MAX_ENTRIES = 240;
const FILE = path.join(DATA_DIR, 'tmp', 'flight-recorder.json');
const TMP = `${FILE}.tmp`;
const startedAt = Date.now();

interface Entry {
  ts: number;
  kind: string;
  detail: string;
}

const entries: Entry[] = [];
let dirty = false;

/** 记一条动作。detail 会被截断，别塞大对象。 */
export function record(kind: string, detail: unknown = ''): void {
  entries.push({ ts: Date.now(), kind, detail: String(detail).slice(0, 220) });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  dirty = true;
}

/** 危险动作前调用：立刻落盘，保证崩溃后能看到「最后一步」。 */
export function flushNow(): void {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const payload = JSON.stringify({
      pid: process.pid,
      node: process.version,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      writtenAt: Date.now(),
      entries,
    });
    fs.writeFileSync(TMP, payload);
    fs.renameSync(TMP, FILE);
  } catch {
    /* 记不下来也不能影响服务本身 */
  }
}

export function startFlightRecorder(intervalMs = 2000): void {
  record('boot', `pid=${process.pid} node=${process.version}`);
  flushNow();
  const timer = setInterval(flushNow, intervalMs);
  timer.unref?.();
  // 正常退出时也留一份
  process.on('exit', flushNow);
  /**
   * 信号处理：记一笔再自己退出。
   * 注意 Node 的语义——一旦注册了 SIGINT/SIGTERM 监听器，默认的「收到就退」就不再生效，
   * 监听器不退出进程就会挂在那里（Ctrl+C 关不掉服务）。所以这里必须显式 process.exit()。
   */
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      record('signal', sig);
      flushNow();
      process.exit(0);
    });
  }
}
