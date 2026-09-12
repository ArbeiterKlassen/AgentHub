import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { ADAPTERS_FILE, ADAPTERS_OVERRIDE_FILE, REPO_ROOT } from './env.js';

export interface AdapterPreset {
  id: string;
  label: string;
  description?: string;
  /** cli = 服务端起进程；http = 服务端请求接口；external = 服务端不代跑，由外部客户端自己接入 */
  kind: 'cli' | 'http' | 'external';
  /** CLI 参数模板，可用占位符见 adapters.json 的 placeholders */
  command?: string;
  args?: string[];
  /** 提示词传递方式：stdin 管道 / 参数内联 / 临时文件路径 */
  input?: 'stdin' | 'arg' | 'file';
  /** 结果读取方式：stdout 纯文本 / 读取 outputFile / 解析 CLI 的 JSON 输出 */
  output?: 'text' | 'file' | 'claude-json' | 'codex-jsonl';
  endpoint?: string;
  model?: string;
  apiKey?: string;
  /** 图片输入能力：CLI 适配器用 flag 展开成 -i <图片>，HTTP 适配器用 mode=openai 走 image_url */
  images?: { flag?: string; mode?: 'openai' | 'none'; max?: number; maxBytes?: number };
  timeoutMs?: number;
  env?: Record<string, string>;
  probe?: string[];
  /**
   * 命令找不到时额外去哪些位置找（支持 `*` 通配与 %ENV% 展开）。
   * 必要性：Codex / Claude Code 这类 CLI 常常只在自己的应用私有 bin 目录里，
   * 从资源管理器双击启动的服务继承不到那份 PATH（报「'codex' 不是内部或外部命令」）。
   */
  searchPaths?: string[];
  builtin?: boolean;
  unverified?: boolean;
  disabled?: boolean;
}

interface AdaptersFile {
  version: number;
  adapters: AdapterPreset[];
}

let cache: { mtime: number; mtime2: number; list: AdapterPreset[] } | null = null;

function readFile(path: string): AdapterPreset[] {
  try {
    const raw = fs.readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as AdaptersFile;
    return Array.isArray(parsed.adapters) ? parsed.adapters : [];
  } catch {
    return [];
  }
}

/** 读取适配器预设：仓库根 adapters.json 打底，数据目录同名文件按 id 覆盖/追加 */
export function loadAdapters(force = false): AdapterPreset[] {
  const statOf = (p: string) => {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  };
  const mtime = statOf(ADAPTERS_FILE);
  const mtime2 = statOf(ADAPTERS_OVERRIDE_FILE);
  if (!force && cache && cache.mtime === mtime && cache.mtime2 === mtime2) return cache.list;

  const base = readFile(ADAPTERS_FILE);
  const override = readFile(ADAPTERS_OVERRIDE_FILE);
  const merged = new Map(base.map((a) => [a.id, a]));
  for (const item of override) {
    merged.set(item.id, { ...merged.get(item.id), ...item });
  }
  const list = [...merged.values()];
  cache = { mtime, mtime2, list };
  return list;
}

export function getAdapter(id: string): AdapterPreset | undefined {
  return loadAdapters().find((a) => a.id === id);
}

/**
 * 这个成员是不是「外部客户端」——服务端不代跑，由 AI 自己挂在外面轮询取消息。
 * 外部成员没有 WebSocket 长连接，所以在线状态要看它的 API 活跃时间，而不是连接数。
 */
export function isExternalAdapter(adapterId: string | null | undefined): boolean {
  if (!adapterId) return false;
  return getAdapter(adapterId)?.kind === 'external';
}

export function adapterVars(extra: Record<string, string> = {}): Record<string, string> {
  return { '{repo}': REPO_ROOT, ...extra };
}

export function substitute(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(key).join(value);
  }
  return out;
}

function findExecutable(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const probe = isWin ? 'where.exe' : 'which';
    const child = spawn(probe, [command], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      resolve(first ?? null);
    });
  });
}

/** 展开 %VAR% / %LOCALAPPDATA% 之类的环境变量（Windows 习惯写法） */
function expandEnvVars(p: string): string {
  return p.replace(/%([^%]+)%/g, (_m, name: string) => process.env[name] ?? process.env[name.toUpperCase()] ?? '');
}

/** 极简通配：只支持路径段里的星号（够用了，例如 Codex 的 bin 下按版本号分目录那种结构） */
function matchGlob(pattern: string): string[] {
  const parts = expandEnvVars(pattern).split(/[\\/]+/).filter(Boolean);
  let current: string[] = [];
  // 盘符（C:）要保留成前缀
  if (parts.length && /^[a-zA-Z]:$/.test(parts[0])) {
    current = [`${parts.shift()}${path.sep}`];
  } else {
    current = [path.sep];
  }
  for (const part of parts) {
    const next: string[] = [];
    for (const base of current) {
      if (!part.includes('*')) {
        next.push(path.join(base, part));
        continue;
      }
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(base);
      } catch {
        continue;
      }
      const re = new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
      for (const entry of entries) {
        if (re.test(entry)) next.push(path.join(base, entry));
      }
    }
    current = next;
  }
  return current.filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

export interface ResolvedCommand {
  path: string;
  /** 从哪里找到的，便于在 UI/日志里说清楚 */
  how: string;
}

/**
 * Windows 上把无扩展名的结果换成可执行的同族文件：
 * `where claude` 会先返回 C:\...\claude（那是给 Git Bash 用的 sh 脚本），cmd 起不来；
 * 同目录下的 claude.cmd / claude.exe 才是能跑的那个。
 */
function preferWindowsExecutable(p: string): string {
  if (process.platform !== 'win32') return p;
  if (/\.(exe|cmd|bat|ps1|com)$/i.test(p)) return p;
  for (const ext of ['.exe', '.cmd', '.bat', '.ps1']) {
    if (fs.existsSync(p + ext)) return p + ext;
  }
  return p;
}

/**
 * 找命令：① 本身就是存在的路径 → ② PATH（where/which）→ ③ 适配器声明的 searchPaths / AH_CLI_SEARCH_PATHS。
 * 第 ③ 步是关键：双击图标启动的服务常常看不到 app 私有 bin 目录。
 */
export function resolveCommandSync(command: string, adapter?: AdapterPreset): ResolvedCommand | null {
  if (!command) return null;
  const direct = expandEnvVars(command);
  if (/[\\/]/.test(direct)) {
    try {
      if (fs.statSync(direct).isFile()) return { path: direct, how: '配置里的绝对路径' };
    } catch {
      /* 继续 */
    }
  }

  // PATH
  try {
    const probe = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(probe, [command], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return { path: preferWindowsExecutable(first), how: 'PATH' };
  } catch {
    /* PATH 里没有，往下找 */
  }

  // 候选位置：适配器自带 + 环境变量里额外声明的
  const extra = String(process.env.AH_CLI_SEARCH_PATHS ?? '')
    .split(/[;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const patterns = [...(adapter?.searchPaths ?? []), ...extra];
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.ps1'] : [''];
  for (const pattern of patterns) {
    const hasExt = /\.(exe|cmd|bat|ps1)$/i.test(pattern);
    for (const ext of hasExt ? [''] : exts) {
      for (const hit of matchGlob(pattern + ext)) {
        return { path: preferWindowsExecutable(hit), how: `候选路径（${pattern}${ext}）` };
      }
    }
  }
  return null;
}

export interface AdapterProbe {
  id: string;
  available: boolean;
  detail: string;
  path?: string | null;
}

/** 探测适配器是否可用：CLI 走 where/which，HTTP 走 /models 探测 */
export async function probeAdapter(adapter: AdapterPreset): Promise<AdapterProbe> {
  if (adapter.disabled) {
    return { id: adapter.id, available: false, detail: '模板未启用，需自行配置 command/args' };
  }
  if (adapter.kind === 'external') {
    return { id: adapter.id, available: true, detail: '由外部客户端自己接入（服务端不代跑）' };
  }
  if (adapter.kind === 'http') {
    const endpoint = adapter.endpoint ?? '';
    const root = endpoint.replace(/\/chat\/completions\/?$/, '');
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${root}/models`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok || res.status === 401 || res.status === 403) {
        return { id: adapter.id, available: true, detail: `HTTP ${res.status} · ${adapter.model ?? ''}` };
      }
      return { id: adapter.id, available: false, detail: `接口返回 ${res.status}` };
    } catch (err) {
      return {
        id: adapter.id,
        available: false,
        detail: `无法连接 ${root}（${err instanceof Error ? err.message : String(err)}）`,
      };
    }
  }
  const command = adapter.command ?? '';
  if (!command || command === 'your-ai-cli') {
    return { id: adapter.id, available: false, detail: '尚未配置命令' };
  }
  const resolved = resolveCommandSync(command, adapter);
  if (!resolved) {
    return {
      id: adapter.id,
      available: false,
      detail: `找不到命令 ${command}（PATH 与候选路径都没有；可用 AH_CLI_SEARCH_PATHS 指定）`,
    };
  }
  return { id: adapter.id, available: true, detail: `${resolved.path}（${resolved.how}）`, path: resolved.path };
}

export async function probeAll(): Promise<AdapterProbe[]> {
  return Promise.all(loadAdapters().map((a) => probeAdapter(a)));
}
