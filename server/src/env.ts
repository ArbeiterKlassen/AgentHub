import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 运行期配置：全部可用环境变量覆盖，默认值面向本机开发。
 * AH_PORT / AH_HOST / AH_DATA_DIR / AH_UPLOAD_MAX / AH_TRUST_LOCAL
 */
const here = fileURLToPath(new URL('.', import.meta.url));

/** 仓库根目录（server/src/env.ts → ../..；编译后 server/dist/env.js → ../..） */
export const REPO_ROOT = path.resolve(here, '..', '..');

export const PORT = Number(process.env.AH_PORT ?? 8787);
export const HOST = process.env.AH_HOST ?? '0.0.0.0';

export const DATA_DIR = process.env.AH_DATA_DIR
  ? path.resolve(process.env.AH_DATA_DIR)
  : path.join(REPO_ROOT, 'data');
export const DB_PATH = path.join(DATA_DIR, 'agenthub.db');
export const FILES_DIR = path.join(DATA_DIR, 'files');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');

export const UPLOAD_MAX_BYTES = Number(process.env.AH_UPLOAD_MAX ?? 512 * 1024 * 1024);

/** 前端构建产物，存在时由后端直接托管（单端口部署） */
export const WEB_DIST = path.join(REPO_ROOT, 'web', 'dist');

/** 适配器预设：仓库根 adapters.json，可被数据目录同名文件覆盖 */
export const ADAPTERS_FILE = path.join(REPO_ROOT, 'adapters.json');
export const ADAPTERS_OVERRIDE_FILE = path.join(DATA_DIR, 'adapters.json');

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, FILES_DIR, TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const ROOM_DEFAULTS = {
  /** 一条讨论链最多允许的 AI 接力跳数 */
  maxHops: Number(process.env.AH_MAX_HOPS ?? 6),
  /** 一条讨论链最多允许的 AI 发言条数 */
  maxTurnsPerChain: Number(process.env.AH_MAX_TURNS ?? 12),
  /** 同一个 AI 两次发言之间的最小间隔 */
  agentCooldownMs: Number(process.env.AH_COOLDOWN_MS ?? 800),
  /** 同时运行的 AI CLI 进程上限 */
  maxConcurrency: Number(process.env.AH_MAX_CONCURRENCY ?? 4),
  /** 触发消息超过这个时间还没轮到执行就丢弃（避免 AI 回过期消息） */
  jobMaxAgeMs: Number(process.env.AH_JOB_MAX_AGE_MS ?? 15 * 60 * 1000),
  /** 单次运行超过这个时长就在群里提示"仍在处理"（默认 2 分钟） */
  progressEveryMs: Number(process.env.AH_PROGRESS_MS ?? 2 * 60 * 1000),
  /** 后续心跳的重复间隔（默认 5 分钟） */
  progressRepeatMs: Number(process.env.AH_PROGRESS_REPEAT_MS ?? 5 * 60 * 1000),
  /** 更新「思考中」状态里的已用时长（默认 15 秒，只在 UI 上体现，不进聊天记录） */
  statusTickMs: Number(process.env.AH_STATUS_TICK_MS ?? 15 * 1000),
};
