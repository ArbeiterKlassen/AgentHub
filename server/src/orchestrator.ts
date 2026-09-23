import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, PORT, REPO_ROOT, ROOM_DEFAULTS, SERVER_SCHEME, TLS_ENABLED } from './env.js';
import {
  findMember,
  findRoom,
  finishRun,
  getFile,
  getMessage,
  insertRun,
  listFiles,
  listMessages,
  listRoomMemberTags,
  now,
  parseJson,
  type MemberRow,
  type MessageRow,
  type RoomRow,
} from './db.js';
import { getAdapter, isExternalAdapter, type AdapterPreset } from './adapters.js';
import { runAdapter } from './agentRunner.js';
import {
  buildAgentPrompt,
  buildDiscussionPrompt,
  cleanAgentReply,
  messageToTranscript,
  type TranscriptLine,
} from './prompt.js';
import { newChainId, postMessage, removeSystemMessage, systemMessage, updateSystemMessage } from './messages.js';
import { broadcast, setAgentStatus, setQueueDepth } from './hub.js';
import { HttpError, newRunId } from './auth.js';

export type JobMode = 'reply' | 'speak' | 'discuss';

export interface Job {
  roomId: string;
  agentTag: string;
  triggerMsgId: number | null;
  chainId: string | null;
  hop: number;
  mode: JobMode;
  topic?: string;
  round?: number;
  rounds?: number;
  /** 本次是否需要在结束后继续路由（讨论模式由外层循环控制） */
  route?: boolean;
}

interface ChainState {
  roomId: string;
  turns: number;
  budget: number;
  startedAt: number;
  lastAt: number;
  stopped: boolean;
  discussion?: boolean;
  /**
   * 为什么停的：
   *   stopped    —— 跳数/预算上限、/stop：在跑的结果没有意义了，丢弃
   *   superseded —— 人类发了新消息让位：正在生成的那一条**仍然发出来**（标记为"回复较早消息"），
   *                 只丢弃还在排队、尚未开工的任务（不白烧算力）
   */
  reason?: 'stopped' | 'superseded';
  /** 让位时那条新消息的 id，用于在群里标注"回复较早消息" */
  supersededBy?: number;
}

const queues = new Map<string, Job[]>();
const pumping = new Set<string>();
const chains = new Map<string, ChainState>();
const triggered = new Map<string, number>();
const pausedRooms = new Set<string>();
const activeDiscussions = new Map<string, string>();
/** chainId → 正在执行的 job 数（用于判断一条链是否真的还在“跑”） */
const runningJobs = new Map<string, number>();
let activeRuns = 0;

const roomMeta = (room: RoomRow): Record<string, unknown> =>
  parseJson<Record<string, unknown>>(room.meta, {});

export const DEFAULT_ROOM_META = {
  maxHops: ROOM_DEFAULTS.maxHops,
  maxTurnsPerChain: ROOM_DEFAULTS.maxTurnsPerChain,
  agentCooldownMs: ROOM_DEFAULTS.agentCooldownMs,
  autoReplyToAgents: false,
  /** 人类发新消息时是否打断还在跑的讨论链（默认开，避免多条链并行刷屏） */
  interruptOnHumanMessage: true,
  /** 长任务心跳：超过这个时长没说话就在群里报一次进度 */
  progressEveryMs: ROOM_DEFAULTS.progressEveryMs,
  /** 后续心跳间隔 */
  progressRepeatMs: ROOM_DEFAULTS.progressRepeatMs,
  /** 拉多少条历史消息当素材（房间级可调：长讨论的群可以放大） */
  historyMessages: ROOM_DEFAULTS.historyMessages,
  /** 其中最近多少条进提示词 */
  contextLines: ROOM_DEFAULTS.contextLines,
  /** 提示词里历史正文的字符预算：太大容易顶爆 CLI 的上下文，太小会忘事 */
  contextMaxChars: ROOM_DEFAULTS.contextMaxChars,
};

/** 外部客户端超过这么久没动静，@ 它时会在群里提醒一句「它可能收不到」 */
const EXTERNAL_STALE_MS = 10 * 60 * 1000;

function humanAgo(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

/** 停止一条讨论链时，把它还没执行的排队任务一起丢掉 */
function dropChainJobs(chainId: string): number {
  let dropped = 0;
  for (const [tag, queue] of queues) {
    const kept = queue.filter((job) => {
      const hit = job.chainId === chainId;
      if (hit) dropped += 1;
      return !hit;
    });
    queues.set(tag, kept);
    setQueueDepth(tag, kept.length);
  }
  return dropped;
}

function stopChain(chain: ChainState, reason: string, roomId: string, chainId: string): void {
  if (chain.stopped) return;
  chain.stopped = true;
  chain.reason = 'stopped';
  const dropped = dropChainJobs(chainId);
  systemMessage(roomId, `${reason}${dropped ? `，已丢弃排队中的 ${dropped} 个任务` : ''}`, {
    chainId,
    level: 'warn',
  });
}

/**
 * 人类发了新消息 → 让上一条讨论链立刻让位（停止接力 + 丢弃排队任务）。
 * 否则多个人类消息会各带一条链并行跑，群里会出现互不相干的接力噪音。
 */
function interruptRoomChains(roomId: string): { stopped: number; dropped: number } {
  let stopped = 0;
  let dropped = 0;
  for (const [id, chain] of chains) {
    if (chain.roomId !== roomId || chain.stopped) continue;
    const hasQueued = [...queues.values()].some((queue) => queue.some((job) => job.chainId === id));
    const hasRunning = (runningJobs.get(id) ?? 0) > 0;
    if (!hasQueued && !hasRunning) continue; // 已经跑完、只是还没清理的空链，不必打扰用户
    chain.stopped = true;
    chain.reason = 'superseded';
    stopped += 1;
    dropped += dropChainJobs(id);
  }
  return { stopped, dropped };
}

function limits(room: RoomRow): typeof DEFAULT_ROOM_META {
  const meta = roomMeta(room) as Partial<typeof DEFAULT_ROOM_META>;
  return { ...DEFAULT_ROOM_META, ...meta };
}

function ensureWorkdir(tag: string): string {
  const dir = path.join(DATA_DIR, 'workspaces', tag);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function acquireSlot(): Promise<void> {
  while (activeRuns >= ROOM_DEFAULTS.maxConcurrency) {
    await new Promise((r) => setTimeout(r, 150));
  }
  activeRuns += 1;
}

function releaseSlot(): void {
  activeRuns = Math.max(0, activeRuns - 1);
}

function pruneTriggered(): void {
  const cutoff = now() - 10 * 60 * 1000;
  for (const [key, ts] of triggered) {
    if (ts < cutoff) triggered.delete(key);
  }
}

/**
 * 房间可能在任何时刻被解散（群主/管理员删房），而这时后台还挂着定时器、重试、讨论循环，
 * 它们随时可能往这个已经不存在的房间发言 —— postMessage 会抛 404，
 * 在 setInterval 里抛就是未捕获异常（直接把服务带崩）。所以所有「延迟/后台」的发消息动作都走这个包装。
 */
function safeSystemMessage(roomId: string, text: string, meta: Record<string, unknown> = {}): MessageRow | null {
  if (!findRoom(roomId)) return null;
  try {
    return systemMessage(roomId, text, meta);
  } catch {
    /* 房间刚好在这一刻被删掉：当成没发生 */
    return null;
  }
}

/**
 * 解散房间时清掉它在调度器里的痕迹：排队任务、讨论链、暂停状态、进行中的讨论标记。
 * 不清的话排队任务会继续跑（然后往一个不存在的房间发消息），/api/status 里也一直挂着这个房间的链。
 */
export function purgeRoomRuntime(roomId: string): { jobs: number; chains: number } {
  let jobs = 0;
  for (const [tag, queue] of queues) {
    const kept = queue.filter((job) => {
      const hit = job.roomId === roomId;
      if (hit) jobs += 1;
      return !hit;
    });
    queue.length = 0;
    queue.push(...kept);
    setQueueDepth(tag, queue.length);
  }
  let chainCount = 0;
  for (const [id, chain] of chains) {
    if (chain.roomId !== roomId) continue;
    chains.delete(id);
    runningJobs.delete(id);
    chainCount += 1;
  }
  pausedRooms.delete(roomId);
  activeDiscussions.delete(roomId);
  return { jobs, chains: chainCount };
}

/**
 * 清理已经停止、且安静了半小时的讨论链。
 * 不清理的话 chains 会随聊天一直长大（每条链都留着状态），跑上几天后 /api/status 会越来越长。
 */
function pruneChains(): void {
  const cutoff = now() - 30 * 60 * 1000;
  for (const [id, chain] of chains) {
    if (!chain.stopped) continue;
    if ((runningJobs.get(id) ?? 0) > 0) continue;
    if (chain.lastAt >= cutoff) continue;
    chains.delete(id);
    runningJobs.delete(id);
  }
  for (const [tag, queue] of queues) {
    if (!queue.length) queues.delete(tag);
  }
}

/* ---------------------------- 队列与执行 ---------------------------- */

export function enqueue(job: Job): void {
  const queue = queues.get(job.agentTag) ?? [];
  queue.push(job);
  queues.set(job.agentTag, queue);
  setQueueDepth(job.agentTag, queue.length);
  void pump(job.agentTag);
}

async function pump(tag: string): Promise<void> {
  if (pumping.has(tag)) return;
  pumping.add(tag);
  try {
    for (;;) {
      const queue = queues.get(tag) ?? [];
      const job = queue.shift();
      setQueueDepth(tag, queue.length);
      if (!job) break;
      if (pausedRooms.has(job.roomId)) continue;
      // 链已停止 / 触发消息过期：直接丢弃，避免 AI 回过期消息
      if (job.chainId && chains.get(job.chainId)?.stopped) continue;
      if (job.triggerMsgId) {
        const trigger = getMessage(job.triggerMsgId);
        if (trigger && Date.now() - trigger.created_at > ROOM_DEFAULTS.jobMaxAgeMs) {
          safeSystemMessage(
            job.roomId,
            `⏭ 跳过 @${job.agentTag} 的一次过期回应（触发消息 #${job.triggerMsgId} 已超过 ${Math.round(ROOM_DEFAULTS.jobMaxAgeMs / 60000)} 分钟）`,
            { chainId: job.chainId, level: 'warn' },
          );
          continue;
        }
      }
      try {
        await executeJob(job);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const room = findRoom(job.roomId);
        if (room) systemMessage(room.id, `⚠️ @${job.agentTag} 处理失败：${message}`);
      }
      const cooldown = findRoom(job.roomId)
        ? limits(findRoom(job.roomId)!).agentCooldownMs
        : ROOM_DEFAULTS.agentCooldownMs;
      if (cooldown > 0) await new Promise((r) => setTimeout(r, cooldown));
    }
  } finally {
    pumping.delete(tag);
    if (!(queues.get(tag) ?? []).length) setAgentStatus(tag, 'idle');
  }
}

interface PreparedJob {
  agent: MemberRow;
  room: RoomRow;
  adapter: AdapterPreset;
  prompt: string;
  trigger: MessageRow | null;
  transcript: TranscriptLine[];
  cwd: string;
  members: MemberRow[];
  files: Array<{ id: string; name: string; size: number }>;
  /** 本次运行的时间上限：成员 meta.timeoutMs 优先，其次适配器默认值 */
  timeoutMs: number;
  /** 触发消息里附带的图片（本地路径），会作为图像输入传给适配器 */
  images: string[];
  imageNames: string[];
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

function imagesOfMessage(row: MessageRow | null): Array<{ path: string; name: string }> {
  if (!row) return [];
  const ids = parseJson<string[]>(row.files, []);
  const out: Array<{ path: string; name: string }> = [];
  for (const id of ids) {
    const file = getFile(id);
    if (!file) continue;
    const isImage = file.mime?.startsWith('image/') || IMAGE_EXT_RE.test(file.name);
    if (!isImage) continue;
    out.push({ path: file.stored_path, name: file.name });
  }
  return out;
}

export function prepareJob(job: {
  roomId: string;
  agentTag: string;
  triggerMsgId?: number | null;
  topic?: string;
  round?: number;
  rounds?: number;
}): PreparedJob {
  const room = findRoom(job.roomId);
  if (!room) throw new HttpError(404, '房间不存在');
  const agent = findMember(job.agentTag);
  if (!agent) throw new HttpError(404, `成员 @${job.agentTag} 不存在`);
  if (agent.kind !== 'agent') throw new HttpError(400, `@${job.agentTag} 不是 AI 成员`);
  const adapter = getAdapter(agent.adapter_id ?? 'mock');
  if (!adapter) throw new HttpError(400, `适配器 ${agent.adapter_id} 未在 adapters.json 中定义`);

  const trigger = job.triggerMsgId ? (getMessage(job.triggerMsgId) ?? null) : null;
  const conf = roomMeta(room);
  const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.round(n), min), max) : fallback;
  };
  const history = listMessages({
    roomId: job.roomId,
    limit: clampInt(conf.historyMessages, ROOM_DEFAULTS.historyMessages, 1, 200),
    before: trigger ? trigger.id : undefined,
  });
  const transcript = [...history, ...(trigger ? [trigger] : [])].map(messageToTranscript);
  const members = listRoomMemberTags(room.id)
    .map((tag) => findMember(tag))
    .filter((m): m is MemberRow => Boolean(m));
  const files = listFiles(room.id)
    .slice(0, 12)
    .map((f) => ({ id: f.id, name: f.name, size: f.size }));
  const cwd = agent.workdir && fs.existsSync(agent.workdir) ? agent.workdir : ensureWorkdir(agent.tag);
  // 单个 AI 可以有自己的时间上限：在成员 meta 里写 {"timeoutMs": 1800000}
  const memberMeta = parseJson<Record<string, unknown>>(agent.meta, {});
  const timeoutMs =
    Number.isFinite(Number(memberMeta.timeoutMs)) && Number(memberMeta.timeoutMs) > 0
      ? Number(memberMeta.timeoutMs)
      : (adapter.timeoutMs ?? 300_000);
  // 触发消息里带的图片：作为图像输入交给适配器（codex → -i，HTTP → image_url）
  const attachedImages = imagesOfMessage(trigger);

  const fileHint = files.length
    ? files.map((f) => `- ${f.name}（${Math.round(f.size / 1024)} KB，id ${f.id}）`).join('\n')
    : '';

  const base = {
    agent,
    member: agent,
    roomName: room.name,
    roomTopic: room.topic,
    members,
    transcript,
    trigger: trigger ? messageToTranscript(trigger) : null,
    fileHint,
    timeoutMs,
    contextLines: clampInt(conf.contextLines, ROOM_DEFAULTS.contextLines, 1, 200),
    contextMaxChars: clampInt(conf.contextMaxChars, ROOM_DEFAULTS.contextMaxChars, 500, 200_000),
    imageNames: attachedImages.map((img) => img.name),
    chainNote: job.round
      ? undefined
      : trigger && trigger.hop > 0
        ? `这是群内第 ${trigger.hop + 1} 跳接力（上限 ${limits(room).maxHops} 跳）。请直接给出你的结论；除非确实需要别人做别的事，否则不要 @ 其他 AI，避免无意义的来回接力。`
        : undefined,
  };
  const prompt = job.topic
    ? buildDiscussionPrompt({
        ...base,
        topic: job.topic,
        round: job.round ?? 1,
        rounds: job.rounds ?? 1,
      })
    : buildAgentPrompt(base);

  return {
    agent,
    room,
    adapter,
    prompt,
    trigger,
    transcript,
    cwd,
    members,
    files,
    timeoutMs,
    images: attachedImages.map((img) => img.path),
    imageNames: attachedImages.map((img) => img.name),
  };
}

async function executeJob(job: Job): Promise<void> {
  const prepared = prepareJob(job);
  const { agent, room, adapter, prompt, trigger, cwd } = prepared;

  // 外部客户端驱动的成员：服务端不代跑（否则会伪造出回复）
  if (adapter.kind === 'external') {
    systemMessage(
      room.id,
      `ℹ️ @${agent.tag} 由外部客户端自己接入（适配器 external），服务端不代跑。` +
        `它应该自己在轮询群消息；如果它没动，检查那台机器上的客户端是否还在运行。`,
      { agentTag: agent.tag, level: 'info', kind: 'external.skip' },
    );
    setAgentStatus(agent.tag, 'idle');
    return;
  }

  const runId = newRunId();
  const started = Date.now();
  const chainId = job.chainId ?? newChainId();

  /**
   * 把该 AI 身份的命令行 profile 同步成「当前房间」。
   *
   * 为什么需要：AI 在群里干长活时经常自己调 `ah` 命令（报进度、传文件），而
   * codex / claude 这类 CLI 会用它们自己的 shell 环境策略过滤掉我们注入的 AH_* 环境变量，
   * 于是 `ah` 会退回 profile 里存的 `room` —— 那个值可能还是它上一次待过的房间，
   * 结果就是「B 组的内容被发到了 OccWorld 群」。每次运行前同步一次即可根治。
   */
  try {
    const profileDir = path.join(os.homedir(), '.agenthub', 'profiles');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, `${agent.tag}.json`),
      `${JSON.stringify(
        {
          server: `${SERVER_SCHEME}://127.0.0.1:${PORT}`,
          tag: agent.tag,
          token: agent.token_secret,
          room: room.name,
          insecure: TLS_ENABLED,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch {
    /* 尽力而为：写不了 profile 也不影响这次运行 */
  }

  insertRun({
    id: runId,
    room_id: room.id,
    agent_tag: agent.tag,
    trigger_msg: trigger?.id ?? null,
    chain_id: chainId,
    hop: job.hop,
    status: 'running',
    adapter_id: adapter.id,
    exit_code: null,
    duration_ms: null,
    error: null,
    prompt,
    output: '',
    created_at: started,
  });

  setAgentStatus(agent.tag, 'thinking', `${adapter.label} · ${trigger ? `回应 #${trigger.id}` : '主动发言'}`);
  broadcast({
    type: 'typing',
    roomId: room.id,
    data: { tag: agent.tag, nickname: agent.nickname, runId, state: 'start' },
    ts: Date.now(),
  });

  runningJobs.set(chainId, (runningJobs.get(chainId) ?? 0) + 1);
  await acquireSlot();

  // 长任务心跳：AI 埋头干长活时不说话，群里看起来像"死了"。
  // statusTick 只更新 UI 上的「思考中 · 已 N 分钟」；超过 progressEveryMs 才在群里留一条进度提示。
  const conf = limits(room);
  const progressEveryMs = Number((conf as Record<string, unknown>).progressEveryMs ?? ROOM_DEFAULTS.progressEveryMs);
  const progressRepeatMs = Number((conf as Record<string, unknown>).progressRepeatMs ?? ROOM_DEFAULTS.progressRepeatMs);
  const label = trigger ? `回应 #${trigger.id}` : '主动发言';
  let lastProgressAt = 0;
  let progressMsgId: number | null = null;

  // 上次进程被杀等情况可能留下「仍在处理」的心跳消息，开工前先清掉同房间同 agent 的旧心跳
  for (const stale of listMessages({ roomId: room.id, limit: 100 })) {
    if (stale.sender_tag !== agent.tag) continue;
    if (parseJson<Record<string, unknown>>(stale.meta, {}).kind === 'run.progress') {
      removeSystemMessage(stale.id);
    }
  }

  const heartbeat = setInterval(() => {
    const elapsed = Date.now() - started;
    const minutes = Math.max(1, Math.round(elapsed / 60000));
    setAgentStatus(agent.tag, 'thinking', `${adapter.label} · 已 ${minutes} 分钟 · ${label}`);
    if (elapsed < progressEveryMs) return;
    if (lastProgressAt && elapsed - lastProgressAt < progressRepeatMs) return;
    lastProgressAt = elapsed;
    const text =
      `⏳ @${agent.tag}（${agent.nickname}）仍在处理（${label}，已 ${minutes} 分钟）。` +
      `它在闷头做长活时不会自动发言，如需中止：发送 /stop（或在 AI 面板点「全部停止」）。`;
    const meta = { runId, agentTag: agent.tag, chainId, level: 'info', kind: 'run.progress' };
    const progressMeta = {
      ...meta,
      i18nKind: 'run.progress',
      i18nParams: { tag: agent.tag, nickname: agent.nickname, label, minutes },
    };
    if (progressMsgId === null) {
      // 第一次：发一条心跳（房间可能已被解散，那就什么都别做）
      const msg = safeSystemMessage(room.id, text, progressMeta);
      if (msg) progressMsgId = msg.id;
    } else {
      // 之后：原地改写这一条，而不是每 2 分钟刷一条新的（系统消息曾经占全群 25%）
      updateSystemMessage(progressMsgId, text, progressMeta);
    }
  }, ROOM_DEFAULTS.statusTickMs);
  heartbeat.unref?.();

  let run;
  try {
    const runOptions = {
      adapter,
      prompt,
      cwd,
      timeoutMs: prepared.timeoutMs,
      vars: {
        '{repo}': REPO_ROOT,
        '{cwd}': cwd,
        '{tag}': agent.tag,
        '{nickname}': agent.nickname,
        '{room}': room.name,
      },
      // 让 AI 在长任务里能自己发进度/传文件：环境变量里直接带上它的身份与房间
      extraEnv: {
        // 服务自身可能是 https（自签证书）：给子进程的地址与证书校验开关都要跟着走，
        // 否则 AI 想用 `ah send` 报进度时会连不上自己的服务。
        AH_SERVER: `${SERVER_SCHEME}://127.0.0.1:${PORT}`,
        AH_TAG: agent.tag,
        AH_TOKEN: agent.token_secret,
        AH_ROOM: room.name,
        ...(TLS_ENABLED ? { AH_INSECURE: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0' } : {}),
      },
      imageFiles: prepared.images,
    };
    run = await runAdapter(runOptions);
    // 「秒退 + 没有任何输出」基本是 provider / 网络抖动（实测遇到过：11 秒退出码 1、无输出），
    // 重试一次即可；真失败（超时、跑完才报错）不重试，避免重复扣费。
    if (!run.ok && !run.text.trim() && run.durationMs < 60_000) {
      safeSystemMessage(
        room.id,
        `↻ @${agent.tag} 首次调用失败（${run.error ?? '未知错误'}），2 秒后自动重试一次…`,
        {
          runId,
          agentTag: agent.tag,
          chainId,
          level: 'warn',
          kind: 'run.retry',
          i18nKind: 'run.retry',
          i18nParams: { tag: agent.tag, error: run.error ?? '未知错误' },
        },
      );
      await new Promise((r) => setTimeout(r, 2000));
      const retry = await runAdapter(runOptions);
      run = retry.ok || retry.text.trim() ? { ...retry, error: undefined } : retry;
    }
  } finally {
    clearInterval(heartbeat);
    // 任务结束：把心跳消息收掉（进度只在跑的时候需要看，留在群里就是噪音）
    if (progressMsgId !== null) removeSystemMessage(progressMsgId);
    releaseSlot();
    runningJobs.set(chainId, Math.max(0, (runningJobs.get(chainId) ?? 1) - 1));
  }

  /**
   * 这次调用期间房间被解散了（群主/管理员删房）：回帖已经没有落脚点，
   * 只把运行记录收尾就好（agent_runs 的行也可能被一起清了，finishRun 会是空操作）。
   */
  if (!findRoom(room.id)) {
    finishRun(runId, {
      status: 'dropped',
      exit_code: run.exitCode,
      duration_ms: run.durationMs,
      error: '房间已被解散，回帖丢弃',
      output: run.stdout.slice(-20_000),
      tokens_in: run.usage?.input ?? null,
      tokens_out: run.usage?.output ?? null,
      tokens_total: run.usage?.total ?? null,
      cost_usd: run.usage?.costUsd ?? null,
    });
    setAgentStatus(agent.tag, 'idle');
    return;
  }

  finishRun(runId, {
    status: run.ok ? 'ok' : 'error',
    exit_code: run.exitCode,
    duration_ms: run.durationMs,
    error: run.error ?? null,
    // token 用量：CLI 报了就记（codex 的 "tokens used"、claude 的 usage 字段），没报就是 null
    tokens_in: run.usage?.input ?? null,
    tokens_out: run.usage?.output ?? null,
    tokens_total: run.usage?.total ?? null,
    cost_usd: run.usage?.costUsd ?? null,
    // 运行记录里同时留下 stdout 与 stderr 尾部：排查「CLI 退出码 1」这类问题时，原因通常只在 stderr 末尾
    output: [run.stdout, run.stderr ? `\n--- stderr ---\n${run.stderr.slice(-6000)}` : '']
      .join('')
      .slice(-20_000),
  });

  broadcast({
    type: 'typing',
    roomId: room.id,
    data: { tag: agent.tag, nickname: agent.nickname, runId, state: 'stop' },
    ts: Date.now(),
  });

  if (!run.ok) {
    setAgentStatus(agent.tag, 'error', run.error ?? '运行失败');
    const timedOut = /超时/.test(run.error ?? '');
    systemMessage(
      room.id,
      (timedOut
        ? `⏱ @${agent.tag}（${agent.nickname}）本次调用达到 ${Math.round(prepared.timeoutMs / 60000)} 分钟上限，被强制中断。` +
          `已经落盘的改动（写文件、传文件）不会回滚，但这次没发出的群回复丢了。\n` +
          `建议：再 @ 它一次并明确「只做哪一步」，或让它先给结论再展开。`
        : `⚠️ @${agent.tag}（${agent.nickname}）调用 ${adapter.label} 失败：${run.error ?? '未知错误'}\n` +
          `可在「Agent 控制台」查看命令：${run.command}`),
      {
        runId,
        agentTag: agent.tag,
        level: 'error',
        i18nKind: timedOut ? 'run.timeout' : 'run.error',
        i18nParams: timedOut
          ? { tag: agent.tag, nickname: agent.nickname, minutes: Math.round(prepared.timeoutMs / 60000) }
          : {
              tag: agent.tag,
              nickname: agent.nickname,
              label: adapter.label,
              error: run.error ?? '未知错误',
              command: run.command,
            },
      },
    );
    return;
  }

  const text = cleanAgentReply(run.text);
  if (!text) {
    setAgentStatus(agent.tag, 'idle');
    systemMessage(room.id, `⚠️ @${agent.tag} 没有输出内容（可能是提示词过长或 CLI 静默退出）`, {
      runId,
      agentTag: agent.tag,
      level: 'warn',
      i18nKind: 'run.empty',
      i18nParams: { tag: agent.tag },
    });
    return;
  }

  // 跑到一半时链可能已经结束：
  //   reason='stopped'（跳数/预算上限、/stop）→ 丢弃，回帖没有意义了
  //   reason='superseded'（人类发了新消息让位）→ **照常发出来**，只是标记为「回复较早消息」，
  //     毕竟这次 AI 调用已经烧掉了（平均 20–200 秒），丢掉纯属浪费
  const liveChain = chains.get(chainId);
  if (liveChain?.stopped && liveChain.reason !== 'superseded') {
      finishRun(runId, {
        status: 'dropped',
        exit_code: run.exitCode,
        duration_ms: run.durationMs,
        error: '讨论链已停止，回帖被丢弃',
        output: run.stdout.slice(-20_000),
        tokens_in: run.usage?.input ?? null,
        tokens_out: run.usage?.output ?? null,
        tokens_total: run.usage?.total ?? null,
        cost_usd: run.usage?.costUsd ?? null,
      });
    setAgentStatus(agent.tag, 'idle');
    systemMessage(
      room.id,
      `⏭ 已丢弃 @${agent.tag} 的迟到回帖（讨论链已停止，消耗 ${Math.round(run.durationMs / 1000)}s）`,
      {
        runId,
        agentTag: agent.tag,
        chainId,
        level: 'warn',
        i18nKind: 'run.dropped',
        i18nParams: { tag: agent.tag, seconds: Math.round(run.durationMs / 1000) },
      },
    );
    return;
  }
  const isLateReply = Boolean(liveChain?.supersededBy);

  const saved = postMessage({
    roomId: room.id,
    sender: { tag: agent.tag, nickname: agent.nickname, kind: 'agent' },
    text,
    replyTo: trigger?.id ?? null,
    chainId,
    hop: job.hop,
    meta: {
      runId,
      adapter: adapter.id,
      durationMs: run.durationMs,
      mode: job.mode,
      round: job.round ?? null,
      topic: job.topic ?? null,
      ...(isLateReply ? { lateReply: true, supersededBy: liveChain?.supersededBy ?? null } : {}),
    },
    knownTags: new Set(prepared.members.map((m) => m.tag)),
  });

  const chain = chains.get(chainId);
  if (chain) {
    chain.turns += 1;
    chain.lastAt = Date.now();
  }
  setAgentStatus(agent.tag, 'idle');

  // 让位后的迟到回复不再继续接力（避免把已经翻篇的话题重新点着）
  if (job.route !== false && job.mode !== 'discuss' && !isLateReply) {
    routeMessage(saved);
  }
}

/* ------------------------------ 路由逻辑 ------------------------------ */

function chainFor(chainId: string, roomId: string, opts: { discussion?: boolean; budget?: number } = {}): ChainState {
  let chain = chains.get(chainId);
  if (!chain) {
    chain = {
      roomId,
      turns: 0,
      budget: opts.budget ?? roomTurnBudget(roomId),
      startedAt: Date.now(),
      lastAt: Date.now(),
      stopped: false,
      discussion: opts.discussion,
    };
    chains.set(chainId, chain);
  }
  return chain;
}

/** 本轮发言上限：优先用房间 meta 的 maxTurnsPerChain，其次全局默认值 */
function roomTurnBudget(roomId: string): number {
  const fallback = ROOM_DEFAULTS.maxTurnsPerChain;
  const room = findRoom(roomId);
  if (!room) return fallback;
  const value = Number(roomMeta(room).maxTurnsPerChain ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 收到新消息后的路由：把消息投递给被 @ 的 AI 成员，以及开启了“所有消息都参与”的 AI。
 * 返回本次排入队列的任务数。
 */
export function routeMessage(row: MessageRow): number {
  const room = findRoom(row.room_id);
  if (!room) return 0;
  if (pausedRooms.has(row.room_id)) return 0;
  if (row.sender_kind === 'system' || row.type === 'system') return 0;

  const meta = parseJson<Record<string, unknown>>(row.meta, {});
  if (meta.noRoute) return 0;

  const memberTags = listRoomMemberTags(row.room_id);
  const known = new Set(memberTags);
  const agents = memberTags
    .map((tag) => findMember(tag))
    .filter((m): m is MemberRow => Boolean(m) && m!.kind === 'agent');
  const agentByTag = new Map(agents.map((a) => [a.tag, a]));
  const mentions = parseJson<string[]>(row.mentions, []);
  /** @全体：唤醒房间里所有 AI（除发言者本人），由 messages.ts 写入 meta */
  const mentionAll = meta.mentionAll === true;
  const conf = limits(room);

  // 人类发言优先：打断上一轮还在跑的接力（可用房间 meta 的 interruptOnHumanMessage=false 关掉）
  if (row.sender_kind === 'human' && conf.interruptOnHumanMessage !== false) {
    const { stopped, dropped } = interruptRoomChains(row.room_id);
    if (stopped || dropped) {
      // 注意：正在生成的那一条会照常发出来（标记「回复较早消息」），这里只说被跳过的排队任务，
      // 没有排队任务时干脆不说话——以前每个新消息都刷一条"让位"提示，太吵。
      for (const [, chain] of chains) {
        if (chain.roomId === room.id && chain.stopped && chain.reason === 'superseded') {
          chain.supersededBy = row.id;
        }
      }
      if (dropped > 0) {
        systemMessage(
          room.id,
          `⏭ 新消息优先，已跳过 ${dropped} 个排队中的任务（正在生成的回复仍会保留，稍后带「回复较早消息」标记发出）`,
          { kind: 'chain.interrupt', level: 'info', i18nKind: 'chain.interrupt', i18nParams: { n: dropped } },
        );
      }
    }
  }

  const targets = new Set<string>();
  /** adapter=external 的成员由它自己的客户端轮询取消息：服务端不代跑，
      否则会出现「服务端生成的回复」和「外部 AI 的回复」以同一个 tag 同时出现在群里 */
  const isExternal = (tag: string): boolean => {
    const agent = agentByTag.get(tag);
    return Boolean(agent) && isExternalAdapter(agent!.adapter_id);
  };
  /** 外部成员最近活跃过吗？（没有 last_seen_at = 从注册后一直没动过） */
  const externalIdleMs = (tag: string): number | null => {
    const seen = agentByTag.get(tag)?.last_seen_at ?? null;
    return seen ? Date.now() - seen : null;
  };
  /**
   * @全体 之后要有可见反馈：以前点完 @全体，除了一堆 AI 陆续回话没有任何说明；
   * 更糟的是 external 成员压根不进服务端队列（它们自己轮询取消息），用户会以为漏通知了。
   */
  const mentionAllNotice = (queued: number, truncated: number): void => {
    if (!mentionAll) return;
    const externalTags = agents
      .filter((a) => a.tag !== row.sender_tag && isExternal(a.tag))
      .map((a) => a.tag);
    const parts: string[] = [
      queued > 0 ? `📣 @全体：已通知 ${queued} 个由服务端自动应答的 AI` : '📣 @全体：本次没有可自动应答的 AI 入队',
    ];
    if (truncated > 0) parts.push(`，另有 ${truncated} 个因本轮剩余额度不足未入队`);
    if (externalTags.length) {
      parts.push(
        `；${externalTags.length} 个外部客户端（${externalTags.map((t) => `@${t}`).join('、')}）不在服务端排队，靠它们自己拉取消息后回复`,
      );
    }
    systemMessage(room.id, parts.join(''), { kind: 'chain.broadcast', level: queued ? 'info' : 'warn' });
  };
  for (const tag of mentions) {
    if (tag !== row.sender_tag && agentByTag.has(tag) && !isExternal(tag)) targets.add(tag);
  }
  if (mentionAll) {
    for (const agent of agents) {
      if (agent.tag !== row.sender_tag && !isExternal(agent.tag)) targets.add(agent.tag);
    }
  }
  if (row.sender_kind === 'human') {
    for (const agent of agents) {
      if (agent.trigger_mode === 'all' && !isExternal(agent.tag)) targets.add(agent.tag);
    }
  } else if (conf.autoReplyToAgents) {
    for (const agent of agents) {
      if (agent.trigger_mode === 'all' && !isExternal(agent.tag)) targets.add(agent.tag);
    }
  }

  /* 被点名的外部客户端如果早就没动静了，提醒一句——不然人会一直等一个根本没挂着的 AI */
  const staleExternal = mentions.filter((tag) => {
    if (tag === row.sender_tag || !agentByTag.has(tag) || !isExternal(tag)) return false;
    const idle = externalIdleMs(tag);
    return idle === null || idle > EXTERNAL_STALE_MS;
  });
  if (staleExternal.length) {
    const detail = staleExternal
      .map((tag) => {
        const idle = externalIdleMs(tag);
        return `@${tag}（${idle === null ? '从未活跃' : `最近活跃于 ${humanAgo(idle)}`}）`;
      })
      .join('、');
    systemMessage(room.id, `⚠️ ${detail} 是外部客户端，现在可能没挂着，回复未必会来`, {
      kind: 'presence.stale',
      level: 'warn',
      tags: staleExternal,
    });
  }

  if (!targets.size) {
    mentionAllNotice(0, 0);
    return 0;
  }

  const chainId = row.chain_id ?? newChainId();
  const chain = chainFor(chainId, room.id);
  const hop = row.hop + 1;

  if (chain.stopped) return 0;
  if (hop > conf.maxHops) {
    stopChain(
      chain,
      `⏹ 讨论链已达最大接力跳数（${conf.maxHops}），自动停止。回复任意消息或在输入框发送 /resume 可继续`,
      room.id,
      chainId,
    );
    return 0;
  }
  const remaining = chain.budget - chain.turns;
  let truncated = 0;
  if (targets.size > remaining) {
    if (mentionAll && remaining > 0) {
      // 群发不因额度不足整条链停摆：按房间成员顺序截断，截断人数在下面的 @全体 反馈里说明
      const kept = [...targets].slice(0, remaining);
      truncated = targets.size - kept.length;
      targets.clear();
      for (const tag of kept) targets.add(tag);
    } else {
      stopChain(chain, `⏹ 讨论链已达本轮发言上限（${chain.budget} 条），自动停止`, room.id, chainId);
      return 0;
    }
  }

  pruneTriggered();
  pruneChains();
  let queued = 0;
  for (const tag of targets) {
    const key = `${row.id}:${tag}`;
    if (triggered.has(key)) continue;
    triggered.set(key, Date.now());
    enqueue({
      roomId: room.id,
      agentTag: tag,
      triggerMsgId: row.id,
      chainId,
      hop,
      mode: 'reply',
    });
    queued += 1;
  }
  mentionAllNotice(queued, truncated);
  return queued;
}

/* ------------------------------ 讨论模式 ------------------------------ */

export interface DiscussionOptions {
  roomId: string;
  topic: string;
  tags: string[];
  rounds?: number;
  initiator?: MemberRow | null;
}

export async function startDiscussion(opts: DiscussionOptions): Promise<{ chainId: string; turns: number }> {
  const room = findRoom(opts.roomId);
  if (!room) throw new HttpError(404, '房间不存在');
  if (activeDiscussions.has(room.id)) throw new HttpError(409, '本房间已有一场讨论在进行中');
  const tags = opts.tags.filter(Boolean);
  if (!tags.length) throw new HttpError(400, '至少需要一个参与讨论的 AI 成员（用 @tag 指定）');
  for (const tag of tags) {
    const member = findMember(tag);
    if (!member) throw new HttpError(404, `成员 @${tag} 不存在`);
    if (member.kind !== 'agent') throw new HttpError(400, `@${tag} 不是 AI 成员`);
  }
  const rounds = Math.min(Math.max(opts.rounds ?? 2, 1), 6);
  const chainId = newChainId();
  chainFor(chainId, room.id, { discussion: true, budget: rounds * tags.length + 4 });
  activeDiscussions.set(room.id, chainId);

  const who = tags.map((t) => `@${t}`).join('、');
  systemMessage(
    room.id,
    `🗣 讨论开始：${opts.topic}｜参与：${who}｜轮数：${rounds}` +
      (opts.initiator ? `｜发起人：@${opts.initiator.tag}` : ''),
    { chainId, kind: 'discussion.start', topic: opts.topic, tags, rounds },
  );

  let turns = 0;
  try {
    for (let round = 1; round <= rounds; round += 1) {
      for (const tag of tags) {
        // 房间中途被解散：剩下的轮次没有意义，直接结束（catch 里的提示也会因为房间没了而被忽略）
        if (!findRoom(room.id)) throw new HttpError(404, '房间已被解散，讨论结束');
        if (pausedRooms.has(room.id)) throw new HttpError(409, '房间已暂停');
        await executeJob({
          roomId: room.id,
          agentTag: tag,
          triggerMsgId: null,
          chainId,
          hop: round - 1,
          mode: 'discuss',
          topic: opts.topic,
          round,
          rounds,
          route: false,
        });
        turns += 1;
      }
    }
  } catch (err) {
    safeSystemMessage(
      room.id,
      `⚠️ 讨论中断：${err instanceof Error ? err.message : String(err)}`,
      { chainId, level: 'error' },
    );
  } finally {
    activeDiscussions.delete(room.id);
  }

  const chain = chains.get(chainId);
  if (chain) chain.stopped = true;
  safeSystemMessage(room.id, `✅ 讨论结束（${turns} 次发言）`, { chainId, kind: 'discussion.end' });
  return { chainId, turns };
}

/* ------------------------------ 控制命令 ------------------------------ */

export function pauseRoom(roomId: string): void {
  pausedRooms.add(roomId);
  systemMessage(roomId, '⏸ 已暂停本房间的 AI 自动接力（发送 /resume 恢复）', {
    kind: 'control',
    i18nKind: 'control.pause',
  });
}

export function resumeRoom(roomId: string): void {
  pausedRooms.delete(roomId);
  systemMessage(roomId, '▶️ 已恢复本房间的 AI 自动接力', { kind: 'control', i18nKind: 'control.resume' });
}

export function stopRoom(roomId: string): number {
  let dropped = 0;
  for (const [tag, queue] of queues) {
    const kept = queue.filter((job) => job.roomId !== roomId);
    dropped += queue.length - kept.length;
    queues.set(tag, kept);
    setQueueDepth(tag, kept.length);
  }
  for (const chain of chains.values()) {
    if (chain.roomId === roomId) chain.stopped = true;
  }
  pausedRooms.add(roomId);
  systemMessage(roomId, `⏹ 已停止排队中的 AI 任务（${dropped} 个）并暂停自动接力`, {
    kind: 'control',
    i18nKind: 'control.stop',
    i18nParams: { n: dropped },
  });
  return dropped;
}

export function isPaused(roomId: string): boolean {
  return pausedRooms.has(roomId);
}

export function orchestratorStatus(): Record<string, unknown> {
  return {
    activeRuns,
    pausedRooms: [...pausedRooms],
    // 只报还有任务的队列：空队列会一直挂在表里（成员删了也留着），列出来只是噪音
    queues: Object.fromEntries([...queues.entries()].filter(([, q]) => q.length > 0).map(([tag, q]) => [tag, q.length])),
    chains: [...chains.entries()].map(([id, c]) => ({
      id,
      roomId: c.roomId,
      turns: c.turns,
      budget: c.budget,
      stopped: c.stopped,
      discussion: Boolean(c.discussion),
      startedAt: c.startedAt,
    })),
    discussions: [...activeDiscussions.keys()],
  };
}

export function speakNow(roomId: string, agentTag: string): void {
  const room = findRoom(roomId);
  if (!room) throw new HttpError(404, '房间不存在');
  enqueue({
    roomId,
    agentTag,
    triggerMsgId: null,
    chainId: newChainId(),
    hop: 0,
    mode: 'speak',
    route: false,
  });
}

/** 供 CLI 边缘运行器（ah agent run）取用的提示词 */
export function promptForAgent(roomId: string, agentTag: string, triggerMsgId?: number | null): {
  prompt: string;
  adapter: AdapterPreset;
  runId: string;
  chainId: string;
  hop: number;
} {
  const prepared = prepareJob({ roomId, agentTag, triggerMsgId: triggerMsgId ?? null });
  return {
    prompt: prepared.prompt,
    adapter: prepared.adapter,
    runId: newRunId(),
    chainId: prepared.trigger?.chain_id ?? newChainId(),
    hop: (prepared.trigger?.hop ?? 0) + 1,
  };
}

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, chain] of chains) {
    if (chain.lastAt < cutoff && !chain.discussion) chains.delete(id);
  }
}, 5 * 60 * 1000).unref();
