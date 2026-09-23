/**
 * 生成一份新的语言包骨架：web/src/locale/<语言码>.json
 *
 *   node scripts/i18n-new-locale.mjs --lang ja-JP --name 日本語
 *   node scripts/i18n-new-locale.mjs --lang ko-KR --name 한국어 --from en-US
 *
 * 骨架的 key 与来源语言完全一致、value 先留空；没翻的条目运行时自动回退到 zh-CN，
 * 所以可以一条条慢慢翻，中途界面不会出现空白。翻完了用 `node scripts/i18n-audit.mjs`
 * 看还差多少条（缺 key 才算错误，空值只算待翻译）。
 *
 * 生成的 JSON：
 *   "_name": "日本語"   ← 语言菜单里显示的名字（以 _ 开头的是元数据，不当作译文）
 *   "nav.chat": ""      ← 待翻译
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALE_DIR = path.join(REPO, 'web', 'src', 'locale');

const argv = process.argv.slice(2);
const value = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const lang = value('lang');
const name = value('name', lang);
const from = value('from', 'zh-CN');
const force = argv.includes('--force');

if (!lang) {
  console.error('用法：node scripts/i18n-new-locale.mjs --lang ja-JP [--name 日本語] [--from zh-CN] [--force]');
  process.exit(1);
}
if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) {
  console.error(`语言码看起来不对：${lang}（形如 ja-JP、ko-KR、pt-BR、zh-TW）`);
  process.exit(1);
}

const sourceFile = path.join(LOCALE_DIR, `${from}.json`);
if (!fs.existsSync(sourceFile)) {
  console.error(`来源语言包不存在：${sourceFile}`);
  process.exit(1);
}
const targetFile = path.join(LOCALE_DIR, `${lang}.json`);
if (fs.existsSync(targetFile) && !force) {
  console.error(`${path.relative(REPO, targetFile)} 已存在；要覆盖就加 --force（会丢掉已有译文）`);
  process.exit(1);
}

const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
const skeleton = { _name: name };
for (const [key, text] of Object.entries(source)) {
  if (key.startsWith('_')) continue;
  // 语言无关的 value（命令、纯符号、纯 ASCII 路径）直接沿用，省得每条都翻
  skeleton[key] = /[\u4e00-\u9fff]/.test(String(text)) ? '' : String(text);
}

fs.writeFileSync(targetFile, `${JSON.stringify(skeleton, null, 2)}\n`, 'utf8');

const total = Object.keys(skeleton).length - 1;
const prefilled = Object.values(skeleton).filter((v) => v !== '').length;
console.log(`已生成 ${path.relative(REPO, targetFile)}`);
console.log(`  语言名：${name}（键名 _name）`);
console.log(`  来源：${path.relative(REPO, sourceFile)}`);
console.log(`  key 共 ${total} 条：${prefilled} 条语言无关已预填，${total - prefilled} 条待翻译`);
console.log('翻完跑一遍：node scripts/i18n-audit.mjs');
