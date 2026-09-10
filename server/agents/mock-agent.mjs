#!/usr/bin/env node
/**
 * 内置模拟 AI：从 stdin 读取 AgentHub 生成的提示词，输出一段“像样”的群聊回复。
 * 不依赖网络与任何外部服务，用于离线演示、联调与自动化测试。
 *
 * 用法（一般由 AgentHub 适配器自动调用）：
 *   node mock-agent.mjs --nickname "小助手" --tag mock-1 [--delay 1200]
 */
import process from 'node:process';

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const nickname = arg('nickname', '模拟 AI');
const tag = arg('tag', 'mock');
const delay = Number(arg('delay', process.env.AH_MOCK_DELAY ?? '0'));

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');

const hash = (input) => {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
};
const pick = (list, seed) => list[hash(seed) % list.length];

/** 解析提示词中的关键片段 */
function section(name) {
  const re = new RegExp(`【${name}】\\s*\\n?([\\s\\S]*?)(?:\\n【|\\n\\n|$)`);
  const m = prompt.match(re);
  return m ? m[1].trim() : '';
}

const roster = section('群成员');
const others = [...roster.matchAll(/@([a-z0-9][a-z0-9_-]*)\s*：([^（(]+)（([^）)]*)）/gi)]
  .map((m) => ({ tag: m[1].toLowerCase(), nickname: m[2].trim(), role: m[3].trim() }))
  .filter((m) => m.tag !== tag);
const otherAgents = others.filter((m) => m.role.startsWith('AI'));
const humans = others.filter((m) => !m.role.startsWith('AI'));

const triggerText = section('这次需要你回应的消息').replace(/^[^：:]*[：:]/, '').trim();
const discussion = prompt.match(/【讨论模式】本轮是第 (\d+)\/(\d+) 轮，讨论主题：「(.+?)」/);
const topic = discussion?.[3] ?? '';
const triggerSpeaker = (prompt.match(/【这次需要你回应的消息】\s*\n?@([a-z0-9_-]+)/i) ?? [])[1] ?? '';
// 引用时去掉所有 @tag，避免「引用别人的话」又被当成一次新的点名
const quote = triggerText
  .replace(/@[a-z0-9_-]+/gi, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 60);
const seed = `${tag}:${prompt.length}:${triggerText.slice(-40)}`;
// 接力跳数：模拟 AI 只在前几跳里继续点名，避免演示时无限接龙
const hop = Number((prompt.match(/这是群内第 (\d+) 跳接力/) ?? [])[1] ?? 0);
const mayChain = process.env.AH_MOCK_ALWAYS_CHAIN === '1' ? true : hop <= 2;

const openers = [
  `我这边先给个判断：`,
  `收到，我补充三点里的两点：`,
  `从我的角度看，这事可以这样拆：`,
  `这条我接一下：`,
  `先对齐一下前提：`,
];

const takes = [
  '把目标压成一句可验证的话，再决定用什么手段，能省掉一半返工。',
  '先做最小闭环验证，跑通了再加自动化，不然调试成本会指数上升。',
  '关键风险在接口契约和失败重试，先把这两处定死，后面都好说。',
  '我倾向于保留一个可回滚的中间态，出问题能立刻退回。',
  '如果目标用户是同一个人的多次使用，那一致性和可重复性比功能数量更重要。',
];

const asks = [
  '你那边能给出一个具体例子吗？',
  '这部分你更熟，帮我确认下结论是否站得住。',
  '你补一个反例，我们把这套方案压一压。',
  '你认为这里应该先做哪一步？',
  '上面这几点你怎么排序？',
];

const lines = [];
if (discussion) {
  lines.push(`第 ${discussion[1]}/${discussion[2]} 轮，我的观点是关于「${topic}」：`);
  lines.push(pick(takes, `${seed}-d`));
  const partner = otherAgents[hash(`${seed}-p`) % Math.max(otherAgents.length, 1)];
  if (partner && (mayChain || discussion[1] !== discussion[2])) {
    lines.push('');
    lines.push(`@${partner.tag} ${pick(asks, `${seed}-a`)}`);
  }
} else if (triggerText) {
  lines.push(`@${triggerSpeaker || 'all'} ${pick(openers, seed)}${quote ? `「${quote}」` : ''}`);
  lines.push(pick(takes, `${seed}-t`));
  const partner = otherAgents.filter((m) => m.tag !== triggerSpeaker)[
    hash(`${seed}-p`) % Math.max(otherAgents.filter((m) => m.tag !== triggerSpeaker).length, 1)
  ];
  if (partner && mayChain) {
    lines.push('');
    lines.push(`@${partner.tag} ${pick(asks, `${seed}-a`)}`);
  } else if (humans[0]) {
    lines.push('');
    lines.push(`@${humans[0].tag} 需要我把这条整理成待办清单吗？`);
  }
} else {
  lines.push(`我主动插一句：${pick(takes, seed)}`);
  const partner = otherAgents[hash(`${seed}-x`) % Math.max(otherAgents.length, 1)];
  if (partner && mayChain) lines.push(`@${partner.tag} ${pick(asks, `${seed}-y`)}`);
}

lines.push('');
lines.push(`—— ${nickname}（${tag} · 内置模拟 AI，仅供演示）`);

if (delay > 0) await new Promise((r) => setTimeout(r, delay));
process.stdout.write(`${lines.join('\n')}\n`);
