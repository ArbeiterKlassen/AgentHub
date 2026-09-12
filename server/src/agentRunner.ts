import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { TMP_DIR } from './env.js';
import { resolveCommandSync, substitute, type AdapterPreset } from './adapters.js';

export interface AgentRunOptions {
  adapter: AdapterPreset;
  prompt: string;
  cwd: string;
  vars: Record<string, string>;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
  /** 额外注入给 CLI 的环境变量（例如 AH_TAG / AH_TOKEN，让 AI 自己也能用 ah 发言） */
  extraEnv?: Record<string, string>;
  /** 本次要作为图像输入附带的本地图片路径（来自触发消息的图片附件） */
  imageFiles?: string[];
}

export interface AgentRunResult {
  ok: boolean;
  text: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
  command: string;
  /** 这次调用烧掉多少 token（CLI 报了就记，没报就不记——不猜） */
  usage?: RunUsage;
}

export interface RunUsage {
  input?: number;
  output?: number;
  total?: number;
  costUsd?: number;
}

const toInt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.replace(/[,\s_]/g, ''));
    if (Number.isFinite(n)) return Math.round(n);
  }
  return undefined;
};

/**
 * 从 CLI 输出里抠 token 用量。各家格式都不一样，这里覆盖常见的几种：
 *  - claude --output-format json ：{"total_cost_usd":0.01,"usage":{"input_tokens":..,"output_tokens":..}}
 *  - codex exec --json           ：{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{...}}}}
 *  - codex exec 普通输出          ：末行 "tokens used\n12,345"
 * 抠不到就返回 undefined —— 宁可没有数字，也不要编一个。
 */
function parseUsage(stdout: string, stderr: string): RunUsage | undefined {
  const usage: RunUsage = {};
  const absorb = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return;
    const u = raw as Record<string, unknown>;
    usage.input ??= toInt(u.input_tokens ?? u.prompt_tokens);
    usage.output ??= toInt(u.output_tokens ?? u.completion_tokens);
    usage.total ??= toInt(u.total_tokens);
  };

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    absorb(obj.usage);
    const payload = obj.payload as Record<string, unknown> | undefined;
    const info = payload?.info as Record<string, unknown> | undefined;
    absorb(info?.total_token_usage ?? info?.last_token_usage);
    if (typeof obj.total_cost_usd === 'number') usage.costUsd ??= obj.total_cost_usd;
  }

  if (usage.total === undefined) {
    const match = /tokens?\s+used[^\d]{0,12}([\d.,]+)/i.exec(`${stderr}\n${stdout}`);
    if (match) usage.total = toInt(match[1]);
  }
  if (usage.total === undefined && (usage.input !== undefined || usage.output !== undefined)) {
    usage.total = (usage.input ?? 0) + (usage.output ?? 0);
  }
  if (usage.input === undefined && usage.output === undefined && usage.total === undefined && usage.costUsd === undefined) {
    return undefined;
  }
  return usage;
}

const ANSI_RE = /\u001b\[[0-9;?]*[a-zA-Z]/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

/** 取字符串尾部若干字符，并把过长的空白压掉，用于展示 CLI 的报错尾部 */
function tailOf(input: string, maxChars: number): string {
  const text = input.replace(/\r\n/g, '\n').trim();
  const tail = text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
  return tail.replace(/\n{3,}/g, '\n\n');
}

/**
 * 解码子进程输出：中文 Windows 的 cmd / 很多 CLI 会吐 GBK 字节，直接 String() 会变成乱码
 * （例如「'codex' 不是内部或外部命令」变成一串问号）。这里先按 UTF-8 严格解，失败再按 GBK。
 */
function decodeChunk(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** 挑出真正可用的图片文件（存在、是文件、不超限），返回绝对路径 */
function usableImages(adapter: AdapterPreset, images: string[] | undefined): string[] {
  const cfg = adapter.images;
  if (!cfg || cfg.mode === 'none' || !images?.length) return [];
  const max = cfg.max ?? 4;
  const maxBytes = cfg.maxBytes ?? 8 * 1024 * 1024;
  const out: string[] = [];
  for (const file of images) {
    if (out.length >= max) break;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) continue;
    } catch {
      continue;
    }
    out.push(file);
  }
  return out;
}

/** CLI 适配器：把 {images} 展开成 -i <图片> 这样的一组参数 */
function buildImageArgs(adapter: AdapterPreset, images: string[]): string[] {
  if (!images.length) return [];
  const flag = adapter.images?.flag ?? '-i';
  return images.flatMap((file) => [flag, file]);
}

/** Windows 上 claude / npm 之类是 .cmd 垫片，必须经 shell 启动 */
function needsShell(): boolean {
  return process.platform === 'win32';
}

function quoteForCmd(value: string): string {
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/"/g, '')}"`;
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      child.kill();
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

function makeTempDir(prefix: string): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_DIR, `${prefix}-`));
}

function parseClaudeJson(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { result?: string };
    if (typeof parsed.result === 'string') return parsed.result;
  } catch {
    /* 可能是多行日志 + 一行 JSON，退化到逐行解析 */
  }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as { result?: string };
      if (typeof parsed.result === 'string') return parsed.result;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function parseCodexJsonl(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  let last: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const evt = JSON.parse(trimmed) as {
        type?: string;
        item?: { type?: string; text?: string };
        msg?: { type?: string; message?: string };
      };
      if (evt.type === 'item.completed' && evt.item?.text) last = evt.item.text;
      if (evt.msg?.type === 'agent_message' && evt.msg.message) last = evt.msg.message;
    } catch {
      /* ignore */
    }
  }
  return last;
}

async function runHttpAdapter(opts: AgentRunOptions): Promise<AgentRunResult> {
  const { adapter, prompt, timeoutMs } = opts;
  const started = Date.now();
  const endpoint = adapter.endpoint ?? '';
  if (!endpoint) {
    return {
      ok: false,
      text: '',
      stdout: '',
      stderr: '',
      exitCode: null,
      durationMs: 0,
      error: '适配器缺少 endpoint',
      command: 'http',
    };
  }
  // 把提示词拆成「规则」与「上下文」两段：小模型对 system 角色的规则遵守度更高
  const splitAt = prompt.indexOf('【最近的群聊记录】');
  const systemPart = splitAt > 0 ? prompt.slice(0, splitAt).trim() : '';
  const userPart = splitAt > 0 ? prompt.slice(splitAt).trim() : prompt;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? adapter.timeoutMs ?? 300_000);
  // HTTP 适配器（Ollama / OpenAI 兼容）：图片走 image_url + data URL
  const images = usableImages(adapter, opts.imageFiles);
  const contentParts = images.length
    ? [
        { type: 'text', text: userPart },
        ...images.map((file) => ({
          type: 'image_url',
          image_url: {
            url: `data:${MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'image/png'};base64,${fs.readFileSync(file).toString('base64')}`,
          },
        })),
      ]
    : userPart;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(adapter.apiKey ? { Authorization: `Bearer ${adapter.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: adapter.model,
        messages: [
          ...(systemPart ? [{ role: 'system', content: systemPart }] : []),
          { role: 'user', content: contentParts },
        ],
        stream: false,
      }),
      signal: controller.signal,
    });
    const raw = await res.text();
    clearTimeout(timer);
    if (!res.ok) {
      return {
        ok: false,
        text: '',
        stdout: raw.slice(0, 4000),
        stderr: '',
        exitCode: res.status,
        durationMs: Date.now() - started,
        error: `HTTP ${res.status}`,
        command: endpoint,
      };
    }
    let text = '';
    try {
      const data = JSON.parse(raw) as {
        choices?: Array<{ message?: { content?: string } }>;
        message?: { content?: string };
        response?: string;
      };
      text =
        data.choices?.[0]?.message?.content ??
        data.message?.content ??
        data.response ??
        '';
    } catch {
      text = raw;
    }
    return {
      ok: Boolean(text.trim()),
      text: stripAnsi(text),
      stdout: raw.slice(0, 200_000),
      stderr: '',
      exitCode: 0,
      durationMs: Date.now() - started,
      error: text.trim() ? undefined : '接口没有返回内容',
      command: endpoint,
    };
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      text: '',
      stdout: '',
      stderr: '',
      exitCode: null,
      durationMs: Date.now() - started,
      error: aborted
        ? `请求超时（${Math.round((timeoutMs ?? adapter.timeoutMs ?? 300000) / 1000)}s）`
        : err instanceof Error
          ? err.message
          : String(err),
      command: endpoint,
    };
  }
}

export async function runAdapter(opts: AgentRunOptions): Promise<AgentRunResult> {
  if (opts.adapter.kind === 'http') return runHttpAdapter(opts);
  return runCliAdapter(opts);
}

async function runCliAdapter(opts: AgentRunOptions): Promise<AgentRunResult> {
  const { adapter, prompt, cwd, vars, onOutput } = opts;
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? adapter.timeoutMs ?? 300_000;
  const tmp = makeTempDir('ahrun');
  const promptFile = path.join(tmp, 'prompt.txt');
  const outputFile = path.join(tmp, 'output.txt');
  fs.writeFileSync(promptFile, prompt, 'utf8');

  const allVars: Record<string, string> = {
    ...vars,
    '{prompt}': prompt,
    '{promptFile}': promptFile,
    '{outputFile}': outputFile,
  };
  const useShell = needsShell();
  const inputMode = adapter.input ?? 'stdin';
  const command = adapter.command ?? '';

  // 先把命令解析成绝对路径：从资源管理器双击启动的服务看不到 Codex / Claude Code 这类
  // 应用私有 bin 目录（那份 PATH 只存在于它们自己的子进程里），会报「不是内部或外部命令」。
  const resolved = resolveCommandSync(command, adapter);
  if (!resolved) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      text: '',
      stdout: '',
      stderr: '',
      exitCode: null,
      durationMs: Date.now() - started,
      error:
        `找不到命令「${command}」：PATH 与候选路径里都没有。\n` +
        `    处理办法：① 安装它；② 或用环境变量 AH_CLI_SEARCH_PATHS 指定目录（分号分隔，支持 * 通配）；` +
        `③ 或在 adapters.json 里给该适配器加 searchPaths。`,
      command: `${command}（未解析到可执行文件）`,
    };
  }
  const exeToRun = resolved.path;
  /** .exe 可以不经 shell 直接起（更安全），.cmd/.bat/.ps1 必须走 shell */
  const needShellForThis = process.platform === 'win32' && !/\.exe$/i.test(exeToRun);
  const images = usableImages(adapter, opts.imageFiles);
  const imageArgs = buildImageArgs(adapter, images);
  const rawArgs = (adapter.args ?? []).flatMap((arg) =>
    arg.includes('{images}') ? imageArgs : [substitute(arg, allVars)],
  );

  const cleanup = (): void => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  return new Promise<AgentRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child: ChildProcess;

    const finish = (result: Partial<AgentRunResult> & { ok: boolean }): void => {
      if (settled) return;
      settled = true;
      let text = result.text ?? '';
      if (adapter.output === 'file') {
        try {
          if (fs.existsSync(outputFile)) {
            const fromFile = fs.readFileSync(outputFile, 'utf8');
            if (fromFile.trim()) text = fromFile;
          }
        } catch {
          /* ignore */
        }
      } else if (adapter.output === 'claude-json') {
        text = parseClaudeJson(stdout) ?? text;
      } else if (adapter.output === 'codex-jsonl') {
        text = parseCodexJsonl(stdout) ?? text;
      }
      cleanup();
      const finalStdout = stripAnsi(stdout);
      const finalStderr = stripAnsi(stderr);
      resolve({
        ok: result.ok,
        text: stripAnsi(text).trim(),
        stdout: finalStdout.slice(-200_000),
        stderr: finalStderr.slice(-40_000),
        exitCode: result.exitCode ?? null,
        durationMs: Date.now() - started,
        error: result.error,
        command: `${command} ${rawArgs.join(' ')}`.trim(),
        usage: parseUsage(finalStdout, finalStderr),
      });
    };

    try {
      const env = {
        ...process.env,
        ...(adapter.env ?? {}),
        ...(opts.extraEnv ?? {}),
        AH_AGENT_TAG: vars['{tag}'] ?? '',
        AH_ROOM: vars['{room}'] ?? '',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      };
      if (useShell && inputMode === 'arg') {
        // Windows 下 arg 模式走 PowerShell：提示词放进变量，避免命令行转义与注入问题
        const psArgs = rawArgs
          .map((a) => {
            if (a === prompt) return '$p';
            return `'${a.replace(/'/g, "''")}'`;
          })
          .join(' ');
        const script = `$ErrorActionPreference='Continue'; $p = Get-Content -Raw -LiteralPath '${promptFile.replace(/'/g, "''")}'; & '${command.replace(/'/g, "''")}' ${psArgs}`;
        child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          cwd,
          env,
          windowsHide: true,
        });
      } else {
      const args = needShellForThis ? rawArgs.map(quoteForCmd) : rawArgs;
      child = spawn(exeToRun, args, {
        cwd,
        env,
        shell: needShellForThis,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      }
    } catch (err) {
      cleanup();
      resolve({
        ok: false,
        text: '',
        stdout: '',
        stderr: '',
        exitCode: null,
        durationMs: Date.now() - started,
        error: `启动失败：${err instanceof Error ? err.message : String(err)}`,
        command,
      });
      return;
    }

    const timer = setTimeout(() => {
      killTree(child);
      finish({ ok: false, error: `执行超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = decodeChunk(chunk);
      stdout += text;
      if (stdout.length > 400_000) stdout = stdout.slice(-200_000);
      onOutput?.(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = decodeChunk(chunk);
      stderr += text;
      if (stderr.length > 100_000) stderr = stderr.slice(-50_000);
      onOutput?.(text);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: `进程错误：${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      const text = adapter.output === 'text' || !adapter.output ? stdout : stdout;
      finish({
        ok: code === 0,
        text,
        exitCode: code,
        // CLI 失败时真正的原因在 stderr 的末尾（前面通常是它回显的提示词），所以取尾部而不是开头
        error:
          code === 0
            ? undefined
            : `退出码 ${code}${stderr ? `：${tailOf(stderr, 500)}` : stdout ? `：${tailOf(stdout, 300)}` : ''}`,
      });
    });

    if (inputMode === 'stdin') {
      child.stdin?.write(prompt, 'utf8');
    }
    child.stdin?.end();
  });
}
