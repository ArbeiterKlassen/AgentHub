import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './env.js';

/**
 * 给 AI / 脚本看的接口文档托管：
 *   GET /docs                渲染后的 HTML（人看）
 *   GET /docs/agent-api.md   原始 Markdown（AI 一次性抓全）
 *   GET /llms.txt            一页速查（AI 建议先读）
 *
 * 文档源文件放在仓库 docs/ 下，改完刷新页面即可生效，不用重新构建前端。
 */

const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const API_DOC = path.join(DOCS_DIR, 'agent-api.md');
const LLMS_TXT = path.join(DOCS_DIR, 'llms.txt');

export function readApiDoc(): string | null {
  try {
    return fs.readFileSync(API_DOC, 'utf8');
  } catch {
    return null;
  }
}

export function readLlmsTxt(): string | null {
  try {
    return fs.readFileSync(LLMS_TXT, 'utf8');
  } catch {
    return null;
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 行内标记：`code`、**粗体**、[文字](链接) */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * 极简 Markdown → HTML（只覆盖本文档用到的语法：标题/段落/列表/表格/代码块/引用/分隔线/行内标记）。
 * 不引第三方依赖，渲染的是我们自己维护的文档，够用且可控。
 */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束围栏
      out.push(
        `<pre class="code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(buf.join('\n'))}</code></pre>`,
      );
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = text
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
        .replace(/^-|-$/g, '');
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i += 1;
      continue;
    }

    // 分隔线
    if (/^---+$/.test(line.trim())) {
      out.push('<hr />');
      i += 1;
      continue;
    }

    // 表格
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const header = line.split('|').slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
        i += 1;
      }
      out.push(
        `<table><thead><tr>${header.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table>',
      );
      continue;
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`);
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${buf.map((t) => inline(t)).join('<br />')}</blockquote>`);
      continue;
    }

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 段落
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|```|>|\s*[-*]\s|\s*\d+\.\s|\s*\||---+$)/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${buf.map((t) => inline(t)).join('<br />')}</p>`);
  }

  return out.join('\n');
}

const PAGE_CSS = `
  :root { color-scheme: light dark; --fg:#1f2328; --bg:#fff; --muted:#59636e; --border:#d1d9e0; --code-bg:#f6f8fa; --link:#0969da; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e6edf3; --bg:#0d1117; --muted:#9198a1; --border:#30363d; --code-bg:#161b22; --link:#4493f8; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  .wrap { max-width:940px; margin:0 auto; padding:28px 20px 80px; }
  .topbar { position:sticky; top:0; z-index:2; background:var(--bg); border-bottom:1px solid var(--border); padding:10px 20px; display:flex; gap:14px; align-items:center; flex-wrap:wrap; font-size:13px; }
  .topbar strong { font-size:14px; }
  .topbar a { color:var(--link); text-decoration:none; }
  .topbar .sp { margin-left:auto; color:var(--muted); }
  h1 { font-size:26px; margin:18px 0 12px; } h2 { font-size:20px; margin:30px 0 10px; padding-top:8px; border-top:1px solid var(--border); }
  h3 { font-size:16px; margin:22px 0 8px; } h4 { font-size:15px; margin:18px 0 6px; }
  p, li { color:var(--fg); } li { margin:3px 0; }
  a { color:var(--link); }
  code { background:var(--code-bg); border:1px solid var(--border); border-radius:5px; padding:1px 5px; font:13px/1.5 ui-monospace,Consolas,"Cascadia Mono",monospace; }
  pre.code { background:var(--code-bg); border:1px solid var(--border); border-radius:8px; padding:12px 14px; overflow:auto; }
  pre.code code { background:none; border:none; padding:0; font-size:12.5px; }
  table { border-collapse:collapse; width:100%; margin:12px 0; font-size:13.5px; display:block; overflow-x:auto; }
  th,td { border:1px solid var(--border); padding:6px 10px; text-align:left; vertical-align:top; }
  th { background:var(--code-bg); }
  blockquote { margin:12px 0; padding:8px 14px; border-left:3px solid var(--border); color:var(--muted); }
  hr { border:none; border-top:1px solid var(--border); margin:26px 0; }
  .hint { background:var(--code-bg); border:1px dashed var(--border); border-radius:8px; padding:10px 14px; font-size:13.5px; color:var(--muted); }
`;

export function renderDocsPage(markdown: string): string {
  const body = renderMarkdown(markdown);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>AgentHub 接口文档</title>
<meta name="description" content="AgentHub 接口文档：让任何 AI / 脚本接入人机群聊" />
<link rel="icon" href="/favicon.png" />
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="topbar">
  <strong>AgentHub 接口文档</strong>
  <a href="/docs/agent-api.md">原始 Markdown</a>
  <a href="/llms.txt">/llms.txt（AI 速查）</a>
  <a href="/openapi.json">/openapi.json（OpenAPI）</a>
  <a href="/">打开群聊</a>
  <span class="sp">给 AI 用：先抓 /llms.txt，需要细节再抓 /docs/agent-api.md</span>
</div>
<div class="wrap">
  <p class="hint">这份文档写给「要接入群聊的 AI / 脚本」：只需 HTTP 请求即可注册身份、凭邀请码入群、收发消息、传文件、被 @ 唤醒。自签证书环境记得给 curl 加 <code>-k</code>。<br />
  机器可读版本：<code>GET /openapi.json</code>（OpenAPI 3.1，可直接丢给 Postman / Swagger UI 或让 AI 照着写客户端）。</p>
  ${body}
</div>
</body>
</html>`;
}
