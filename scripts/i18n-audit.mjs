/**
 * 本地化审计：扫描 web/src 里用到的 t('key') / tOptional('key')，与 web/src/locale/*.json 对照。
 *
 *   node scripts/i18n-audit.mjs           只看报告
 *   node scripts/i18n-audit.mjs --dump    额外打印所有 key（方便补词条）
 *
 * 语言包是自动发现的：locale/ 里放几个 JSON 就审几个。
 * 「缺 key」是硬错误（会 exit 1）；「值还是空的」只算待翻译，不影响退出码，
 * 因为新语言就是这样一条条翻起来的（运行时回退到 zh-CN）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(REPO, 'web');
const SRC = path.join(WEB, 'src');
const LOCALE_DIR = path.join(SRC, 'locale');
const FALLBACK = 'zh-CN';

const LOCALES = fs
  .readdirSync(LOCALE_DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });

const used = new Map(); // key -> 文件列表
for (const file of walk(SRC)) {
  if (file.includes(`${path.sep}lib${path.sep}i18n.ts`)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\bt(?:Optional)?\(\s*'([a-zA-Z0-9_.]+)'/g)) {
    const key = m[1];
    if (!used.has(key)) used.set(key, []);
    const rel = path.relative(WEB, file);
    if (!used.get(key).includes(rel)) used.get(key).push(rel);
  }
  // 数组型常量把 key 放在 xxxKey 字段里（如 descKey / cmdKey），渲染时再 t(item.descKey)
  for (const m of text.matchAll(/[a-zA-Z0-9_]*Key:\s*'([a-zA-Z0-9_.]+)'/g)) {
    const key = m[1];
    if (!used.has(key)) used.set(key, []);
    const rel = path.relative(WEB, file);
    if (!used.get(key).includes(rel)) used.get(key).push(rel);
  }
  // 系统消息走的是 `system.${i18nKey}` 动态拼接，这里单独提示
}

const dicts = Object.fromEntries(
  LOCALES.map((loc) => {
    const file = path.join(LOCALE_DIR, `${loc}.json`);
    return [loc, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}];
  }),
);

const fallbackDict = dicts[FALLBACK] ?? dicts[LOCALES[0]] ?? {};
const isEmpty = (v) => typeof v !== 'string' || v.trim() === '';

/** 每个语言：缺 key（硬错误）与待翻译（空值，仅提示）分开算 */
const report = LOCALES.map((loc) => {
  const dict = dicts[loc];
  const missing = [...used.keys()].filter((k) => !(k in dict));
  const pending = [...used.keys()].filter((k) => k in dict && isEmpty(dict[k]));
  return { loc, dict, missing, pending };
});
const unusedZh = Object.keys(fallbackDict).filter(
  (k) => !k.startsWith('_') && !used.has(k) && !k.startsWith('system.'),
);

/* 服务端发出的系统消息模板 key（meta.i18nKind）也必须能在词条表里找到 */
const serverKinds = new Set();
const serverDir = path.join(REPO, 'server', 'src');
for (const file of fs.readdirSync(serverDir).filter((f) => f.endsWith('.ts'))) {
  const text = fs.readFileSync(path.join(serverDir, file), 'utf8');
  for (const m of text.matchAll(/i18nKind:\s*'([a-zA-Z0-9_.]+)'/g)) serverKinds.add(m[1]);
  for (const m of text.matchAll(/i18nKind:\s*[^,\n]*\?\s*'([a-zA-Z0-9_.]+)'\s*:\s*'([a-zA-Z0-9_.]+)'/g)) {
    serverKinds.add(m[1]);
    serverKinds.add(m[2]);
  }
}
const systemMissing = LOCALES.map((loc) => ({
  loc,
  missing: [...serverKinds].filter((k) => !(`system.${k}` in dicts[loc])),
}));
const systemGap = systemMissing.filter((s) => s.missing.length);
console.log(
  `\n服务端系统消息模板 ${serverKinds.size} 个${
    systemGap.length ? `｜缺词条 ${systemGap.map((s) => `${s.loc}:${s.missing.join(',')}`).join(' ')}` : '（词条齐）'
  }`,
);

console.log(`\n语言包目录：${path.relative(REPO, LOCALE_DIR)}（共 ${LOCALES.length} 个）`);
console.log(`代码里用到 ${used.size} 个 key`);
for (const r of report) {
  const done = used.size - r.missing.length - r.pending.length;
  console.log(
    `  ${r.loc.padEnd(8)} 已翻译 ${String(done).padStart(4)} / 待翻译 ${String(r.pending.length).padStart(4)} / 缺 key ${r.missing.length}`,
  );
}

const hardErrors = report.filter((r) => r.missing.length);
for (const r of hardErrors) {
  console.log(`\n${r.loc} 缺词条 ${r.missing.length} 个：\n  ${r.missing.join('\n  ')}`);
}
const pendingAll = report.filter((r) => r.pending.length && r.loc !== FALLBACK);
for (const r of pendingAll) {
  console.log(`\n${r.loc} 还有 ${r.pending.length} 条待翻译（运行时回退到 ${FALLBACK}）`);
}
console.log(`\nJSON 里未使用 ${unusedZh.length} 个${unusedZh.length ? '：\n  ' + unusedZh.join('\n  ') : ''}`);

if (process.argv.includes('--dump')) {
  console.log('\n=== 全部 key ===');
  console.log([...used.keys()].sort().join('\n'));
}
process.exit(hardErrors.length || systemGap.length ? 1 : 0);
