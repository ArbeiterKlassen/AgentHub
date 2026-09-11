import fs from 'node:fs';
import { spawn } from 'node:child_process';
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
  const resolved = await findExecutable(command);
  if (!resolved) {
    return { id: adapter.id, available: false, detail: `PATH 中找不到命令 ${command}` };
  }
  return { id: adapter.id, available: true, detail: resolved, path: resolved };
}

export async function probeAll(): Promise<AdapterProbe[]> {
  return Promise.all(loadAdapters().map((a) => probeAdapter(a)));
}
