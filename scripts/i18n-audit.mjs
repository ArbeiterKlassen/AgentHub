/**
 * 本地化审计：扫描 web/src 里用到的 t('key') / tOptional('key')，与 locales/*.json 对照。
 *
 *   node data/tmp/i18n-audit.mjs           只看报告
 *   node data/tmp/i18n-audit.mjs --dump    额外打印所有 key（方便补词条）
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(REPO, 'web');
const SRC = path.join(WEB, 'src');
const LOCALES = ['zh-CN', 'en-US'];

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
    const file = path.join(SRC, 'locales', `${loc}.json`);
    return [loc, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}];
  }),
);

const missingZh = [...used.keys()].filter((k) => !(k in dicts['zh-CN']));
const missingEn = [...used.keys()].filter((k) => !(k in dicts['en-US']));
const unusedZh = Object.keys(dicts['zh-CN']).filter((k) => !used.has(k) && !k.startsWith('system.'));

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
const missingSystemZh = [...serverKinds].filter((k) => !(`system.${k}` in dicts['zh-CN']));
const missingSystemEn = [...serverKinds].filter((k) => !(`system.${k}` in dicts['en-US']));
console.log(
  `\n服务端系统消息模板 ${serverKinds.size} 个${missingSystemZh.length || missingSystemEn.length ? `｜缺词条 zh:${missingSystemZh.join(',') || '无'} en:${missingSystemEn.join(',') || '无'}` : '（词条齐）'}`,
);

console.log(`代码里用到 ${used.size} 个 key`);
for (const loc of LOCALES) console.log(`  ${loc}: ${Object.keys(dicts[loc]).length} 条词条`);
console.log(`\n中文缺词条 ${missingZh.length} 个${missingZh.length ? '：\n  ' + missingZh.join('\n  ') : ''}`);
console.log(`\n英文缺词条 ${missingEn.length} 个${missingEn.length ? '：\n  ' + missingEn.join('\n  ') : ''}`);
console.log(`\nJSON 里未使用 ${unusedZh.length} 个${unusedZh.length ? '：\n  ' + unusedZh.join('\n  ') : ''}`);

if (process.argv.includes('--dump')) {
  console.log('\n=== 全部 key ===');
  console.log([...used.keys()].sort().join('\n'));
}
process.exit(missingZh.length || missingEn.length || missingSystemZh.length || missingSystemEn.length ? 1 : 0);
