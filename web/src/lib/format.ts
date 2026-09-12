export function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function formatDay(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return '今天';
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return `${formatDay(ts)} ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

/** 「3 分钟前」这种相对时间，用来显示外部客户端最后一次活跃 */
export function formatRelative(ts: number, base = Date.now()): string {
  const diff = Math.max(base - ts, 0);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** @全体 的几种写法（与后端 ALL_MENTION_RE 保持同一口径） */
export const ALL_MENTION_ALIASES = ['all', 'everyone', '全体成员', '全体', '所有人', '全员'] as const;

export function isAllMentionToken(token: string): boolean {
  const bare = token.startsWith('@') ? token.slice(1) : token;
  return ALL_MENTION_ALIASES.some((alias) => alias.toLowerCase() === bare.toLowerCase());
}

/** 把消息文本按 @tag（含 @全体）切成片段，便于高亮渲染 */
export function splitMentions(text: string): Array<{ type: 'text' | 'mention'; value: string }> {
  // 与后端 prompt.ts 同一口径：邮箱/URL 里的 @ 不算提及
  const re = /(?<![\w.%+/-])(?:@(?:全体成员|全体|所有人|全员)|@[a-z0-9][a-z0-9_-]{1,31})/gi;
  const parts: Array<{ type: 'text' | 'mention'; value: string }> = [];
  let last = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ type: 'text', value: text.slice(last, index) });
    parts.push({ type: 'mention', value: match[0] });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}
