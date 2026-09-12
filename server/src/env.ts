import fs from 'node:fs';
import os from 'node:os';
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

/** 可选 HTTPS：设了这两个路径且文件存在，就用 https 起服务（WebSocket 自动变 wss） */
export const TLS_CERT = process.env.AH_TLS_CERT ?? '';
export const TLS_KEY = process.env.AH_TLS_KEY ?? '';
export const TLS_ENABLED = Boolean(TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY));
/** 服务自己对外用的协议（本机自检、派生给 AI 子进程的 AH_SERVER 都按它来） */
export const SERVER_SCHEME = TLS_ENABLED ? 'https' : 'http';

/** 适配器预设：仓库根 adapters.json，可被数据目录同名文件覆盖 */
export const ADAPTERS_FILE = path.join(REPO_ROOT, 'adapters.json');
export const ADAPTERS_OVERRIDE_FILE = path.join(DATA_DIR, 'adapters.json');

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, FILES_DIR, TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export interface LanAddress {
  address: string;
  iface: string;
}

/**
 * 列出可供手机/别的设备访问的 IPv4 地址。
 * 排除回环与 169.254 链路本地；VMware / Hyper-V / WSL / Docker 之类的虚拟网卡排在后面，
 * 因为「第一个网卡」经常是虚拟网卡（本机就是 VMware 的 192.168.175.1），会让手机连错地址。
 */
export function lanAddresses(): LanAddress[] {
  const virtualHint = /vmware|virtualbox|hyper-?v|vethernet|tailscale|zerotier|docker|wsl|loopback|蓝牙|bluetooth/i;
  const found: LanAddress[] = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue;
      found.push({ address: net.address, iface });
    }
  }
  return found.sort((a, b) => {
    const av = virtualHint.test(a.iface) ? 1 : 0;
    const bv = virtualHint.test(b.iface) ? 1 : 0;
    if (av !== bv) return av - bv;
    return a.address.localeCompare(b.address);
  });
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
  /** 每次调用 AI 时拉多少条历史消息（再从中截取进提示词的那部分） */
  historyMessages: Number(process.env.AH_HISTORY_MESSAGES ?? 30),
  /** 进提示词的最近消息条数 */
  contextLines: Number(process.env.AH_CONTEXT_LINES ?? 24),
  /** 进提示词的历史正文字符预算（超出就从最旧的开始丢） */
  contextMaxChars: Number(process.env.AH_CONTEXT_MAX_CHARS ?? 6000),
};
