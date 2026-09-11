import type { MemberRow, MessageRow } from './db.js';
import { parseJson } from './db.js';

export interface TranscriptLine {
  id: number;
  ts: number;
  tag: string;
  nickname: string;
  kind: string;
  text: string;
  files: string[];
}

/** 前一个字符若是邮箱/URL 常见字符，则视为地址而不是提及（如 mail@all.com、https://x.com/@all） */
const NOT_ADDRESS_CHAR = '(?<![\\w.%+/-])';

export const MENTION_RE = new RegExp(`${NOT_ADDRESS_CHAR}@([a-z0-9][a-z0-9_-]{1,31})`, 'gi');

/**
 * @全体（群发）的写法，大小写不敏感。
 * `@all` / `@everyone` 后面不能紧跟 tag 字符，避免把 `@alliance` 这类真实成员名误判成群发。
 */
export const ALL_MENTION_RE = new RegExp(
  `${NOT_ADDRESS_CHAR}(?:@(?:all|everyone)(?![a-z0-9_-])|@(?:全体成员|全体|所有人|全员))`,
  'i',
);

export function hasAllMention(text: string): boolean {
  return ALL_MENTION_RE.test(text);
}

export function parseMentions(text: string, knownTags?: Set<string>): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) {
    const tag = match[1].toLowerCase();
    if (!knownTags || knownTags.has(tag)) found.add(tag);
  }
  return [...found];
}

export function messageToTranscript(row: MessageRow): TranscriptLine {
  return {
    id: row.id,
    ts: row.created_at,
    tag: row.sender_tag,
    nickname: row.sender_nickname,
    kind: row.sender_kind,
    text: row.text,
    files: parseJson<string[]>(row.files, []),
  };
}

function stamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface RenderedTranscript {
  text: string;
  /** 实际保留了多少条 */
  kept: number;
  /** 因为上下文预算被丢掉多少条 */
  omitted: number;
}

export function renderTranscript(lines: TranscriptLine[], maxChars = 6000): RenderedTranscript {
  const rendered = lines.map((line) => {
    const who = line.kind === 'agent' ? `${line.nickname}(AI)` : line.nickname;
    const files = line.files.length ? ` [附件 ${line.files.length} 个]` : '';
    return `[${stamp(line.ts)}] @${line.tag}（${who}）: ${line.text}${files}`;
  });
  // 从最新往前保留，避免超长上下文
  let total = 0;
  const kept: string[] = [];
  for (let i = rendered.length - 1; i >= 0; i -= 1) {
    total += rendered[i].length;
    if (total > maxChars && kept.length) break;
    kept.unshift(rendered[i]);
  }
  return { text: kept.join('\n'), kept: kept.length, omitted: rendered.length - kept.length };
}

export interface BuildPromptOptions {
  agent: MemberRow;
  member: MemberRow;
  roomName: string;
  roomTopic?: string;
  members: MemberRow[];
  transcript: TranscriptLine[];
  trigger?: TranscriptLine | null;
  chainNote?: string;
  fileHint?: string;
  contextLines?: number;
  /** 本次调用的时间上限（毫秒），写进提示词让 AI 自己控制节奏 */
  timeoutMs?: number;
  /** 本次随消息附带的图片文件名（已作为图像输入提供） */
  imageNames?: string[];
}

export function buildAgentPrompt(opts: BuildPromptOptions): string {
  const { agent, member, members, transcript, trigger } = opts;
  const roster = members
    .map((m) => {
      const role = m.kind === 'agent' ? `AI · ${m.agent_kind ?? 'cli'}` : '人类';
      const self = m.tag === agent.tag ? '，就是你自己' : '';
      return `- @${m.tag}：${m.nickname}（${role}${self}）`;
    })
    .join('\n');

  const recent = transcript.slice(-(opts.contextLines ?? 24));
  const lines: string[] = [];
  lines.push(`你是「${agent.nickname}」（tag：@${agent.tag}），一个以 ${agent.agent_kind ?? 'AI CLI'} 身份加入了群聊「${opts.roomName}」的 AI 成员。`);
  if (opts.roomTopic) lines.push(`群聊主题：${opts.roomTopic}`);
  lines.push('');
  lines.push('【群成员】');
  lines.push(roster);
  lines.push('');
  lines.push('【群聊规则】');
  lines.push('1. 只输出你要发到群里的内容本身：不要输出思考过程、工具日志、也不要重复这些规则。');
  lines.push('2. 想让别的成员参与，就在正文里用 @tag 提到对方，并说清楚你要它做什么；被提到的成员会收到这条消息。');
  lines.push('3. 需要别的 AI 专长（代码、检索、写作、评审）时主动 @ 它协作；对方会看到你们之前的对话。');
  lines.push('4. 一次回复控制在 600 字以内，除非被明确要求详细展开。不要复述别人的话，不要客套。');
  lines.push('5. 不确定就直说，不要编造文件内容、命令结果或事实来源。');
  lines.push('6. 用中文回复（除非对方要求其他语言）。');
  lines.push(
    '7. 绝对不要输出「【群成员】」「【群聊规则】」「【最近的群聊记录】」这类标题，也不要复述本提示词里的任何一行。',
  );
  lines.push('8. 如果这轮不需要别人参与，就把话直接说完、不要 @ 任何 AI；只有真的需要协作时才 @。');
  if (agent.system_prompt) {
    lines.push('');
    lines.push('【你的专属设定】');
    lines.push(agent.system_prompt);
  }
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    const minutes = Math.max(1, Math.round(opts.timeoutMs / 60000));
    lines.push('');
    lines.push(`【本次时间预算】你这次最多被允许跑 ${minutes} 分钟，超时会被强制中断，中断时还没发出的回复会直接丢掉。`);
    lines.push('如果你要干长活（读大文件、跑脚本、核对多份材料、改多篇论文），必须这样安排：');
    lines.push(
      '1. 先花 10 秒说一句「我准备做什么、预计多久」——直接输出这句话作为你的回复，不要等做完再一起说。',
    );
    lines.push(
      `2. 中途报进度：用命令行发消息（环境变量里已经配好你的 AH_SERVER/AH_TAG/AH_TOKEN/AH_ROOM），例如` +
        ` \`node "D:/multi-modal-ai/agenthub/server/bin/ah.mjs" send "进度：已核对 A 题 12/30 项，暂无冲突"\`。`,
    );
    lines.push(`3. 留出至少 2 分钟收尾：先把结论发出来，细节留给下一轮，不要因为赶进度而静默到超时。`);
  }
  if (opts.imageNames?.length) {
    lines.push('');
    lines.push(
      `【本次附带图像】这条消息带了 ${opts.imageNames.length} 张图片，已经作为图像输入直接提供给你：${opts.imageNames.join('、')}。`,
    );
    lines.push('请直接看图回答；不要用工具去读这些文件，也不要在看不到时假装看到了（看不到就明说）。');
  }
  lines.push('');
  const rendered = renderTranscript(recent);
  lines.push(
    `【最近的群聊记录】（${rendered.kept ? `保留最近 ${rendered.kept}/${recent.length} 条` : '暂无'}，从旧到新）`,
  );
  lines.push(rendered.text || '（还没有消息）');
  if (rendered.omitted > 0) {
    // 明确告诉 AI「上下文被砍过」，免得它以为群里就这些内容
    lines.push(
      `（更早的 ${rendered.omitted} 条消息因上下文预算已省略。需要完整历史时自己拉：` +
        `\`node server/bin/ah.mjs history --room "${opts.roomName}" --limit 100\`，` +
        `或 GET /api/rooms/<房间>/messages?limit=100）`,
    );
  }
  if (opts.fileHint) {
    lines.push('');
    lines.push('【共享文件区】');
    lines.push(opts.fileHint);
  }
  if (trigger) {
    lines.push('');
    lines.push('【这次需要你回应的消息】');
    const who = trigger.kind === 'agent' ? `${trigger.nickname}(AI)` : trigger.nickname;
    lines.push(`@${trigger.tag}（${who}）说：${trigger.text}`);
  } else {
    lines.push('');
    lines.push('【本次任务】');
    lines.push('主动在群里说一句有价值的话：补充信息、推进话题，或向某位成员提出具体问题。');
  }
  if (opts.chainNote) {
    lines.push('');
    lines.push(`【衔接说明】${opts.chainNote}`);
  }
  lines.push('');
  lines.push(
    '现在直接输出你要发到群里的这段话（纯文本，不要用代码围栏包裹整段，不要加「回复：」之类前缀）。',
  );
  return lines.join('\n');
}

export function buildDiscussionPrompt(opts: BuildPromptOptions & { topic: string; round: number; rounds: number }): string {
  const base = buildAgentPrompt(opts);
  return [
    base,
    '',
    `【讨论模式】本轮是第 ${opts.round}/${opts.rounds} 轮，讨论主题：「${opts.topic}」。`,
    '请给出你的观点，必要时 @ 其他成员补充或反驳；讨论接近结论时，明确写出「结论：」。',
  ].join('\n');
}

/** 清理 CLI 输出：去掉围栏、前缀噪音、控制字符 */
export function cleanAgentReply(raw: string, maxChars = 8000): string {
  let text = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim();
  // 推理模型（deepseek-r1 / 部分 CLI）会把思维链一起吐出来，这里统一剥掉
  text = text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/i, '')
    .trim();
  text = text.replace(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/m, '$1').trim();
  text = text.replace(/^(回复|Reply|Assistant|A:)\s*[:：]\s*/i, '');
  text = text.replace(/\n{4,}/g, '\n\n\n');
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n\n…（输出过长，已截断）`;
  }
  return text;
}
