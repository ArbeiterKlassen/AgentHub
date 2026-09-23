import { useEffect, useState } from 'react';

/**
 * 网页端本地化。语言包就是 `web/src/locale/` 里的一个个 JSON，**文件名即语言码**
 * （`zh-CN.json` → `zh-CN`，`ja-JP.json` → `ja-JP`）。
 *
 * 加一门语言不需要动任何代码：
 *   1. node scripts/i18n-new-locale.mjs --lang ja-JP --name 日本語
 *      （从最全的语言包生成同 key 的骨架，value 先留空）
 *   2. 逐条把 value 翻译掉；没翻的 key 运行时自动回退到 zh-CN，界面不会出现空白
 *   3. 刷新页面，右上角语言菜单里就多出「日本語」，localStorage 里记住选择
 *
 * 文件里以 `_` 开头的键是元数据，不当作译文：
 *   `_name`  语言自己的名字（语言菜单里显示这个，例如「日本語」「English」）
 *   以 `_` 开头的**文件**（例如 `_template.json`）会被整体忽略，方便放草稿。
 *
 * 三条设计约束：
 *   一，key 固定、value 是译文，改文案不动代码；
 *   二，locale 只存在浏览器本地，不参与任何服务端请求，接口契约与通信行为不变；
 *   三，认出 key 就本地化，认不出就原样显示（系统消息由服务端生成，必须允许回退）。
 */

type Dict = Record<string, string>;

const STORAGE_KEY = 'agenthub-locale';
const FALLBACK_CODE = 'zh-CN';

/** Vite 在构建时把 locale/*.json 全部内联进来；新增文件无需改代码 */
const modules = import.meta.glob('../locale/*.json', { eager: true }) as Record<string, { default?: Dict } | Dict>;

export interface LocaleInfo {
  /** 语言码，等于文件名 */
  code: string;
  /** 语言自己的名字，取自 `_name`，缺省就用语言码 */
  name: string;
  /** 已翻译的条目数（不含 `_` 元数据） */
  translated: number;
}

const RESOURCES: Record<string, Dict> = {};

const entries: LocaleInfo[] = Object.entries(modules)
  .map(([file, mod]) => {
    const code = file.replace(/^.*\//, '').replace(/\.json$/, '');
    const dict = ((mod as { default?: Dict }).default ?? (mod as Dict)) as Dict;
    return { code, dict };
  })
  .filter(({ code }) => !code.startsWith('_'))
  .map(({ code, dict }) => {
    RESOURCES[code] = dict;
    return { code, name: dict._name || code, translated: Object.keys(dict).filter((k) => !k.startsWith('_')).length };
  })
  // 兜底语言永远排第一，其余按语言码排序，语言菜单顺序稳定
  .sort((a, b) =>
    a.code === FALLBACK_CODE ? -1 : b.code === FALLBACK_CODE ? 1 : a.code.localeCompare(b.code),
  );

if (!entries.length) throw new Error('locale/ 下没有任何语言包，界面将无法渲染');

export const LOCALES: string[] = entries.map((e) => e.code);
export const LOCALE_LABELS: Record<string, string> = Object.fromEntries(entries.map((e) => [e.code, e.name]));
export const LOCALE_INFOS: LocaleInfo[] = entries;
export type Locale = string;

/** 兜底语言：优先 zh-CN，没有就挑条目最多的那份 */
const fallbackEntry: LocaleInfo =
  entries.find((e) => e.code === FALLBACK_CODE) ??
  entries.reduce((best, cur) => (cur.translated > best.translated ? cur : best), entries[0]);
const FALLBACK: string = fallbackEntry.code;
const fallbackDict: Dict = RESOURCES[FALLBACK] ?? {};

/** 按浏览器语言挑一份最接近的：先精确匹配，再同语族匹配（zh-Hans → zh-CN、en-GB → en-US） */
function matchLocale(tag: string): string | null {
  const raw = tag.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const exact = LOCALES.find((code) => code.toLowerCase() === lower);
  if (exact) return exact;
  const family = lower.split('-')[0];
  const sameFamily = LOCALES.filter((code) => code.toLowerCase().split('-')[0] === family);
  if (!sameFamily.length) return null;
  return sameFamily.find((code) => /hans|cn$/i.test(code)) ?? sameFamily[0];
}

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LOCALES.includes(saved)) return saved;
    const guessed = matchLocale(navigator.language ?? '');
    if (guessed) return guessed;
    for (const tag of navigator.languages ?? []) {
      const hit = matchLocale(tag);
      if (hit) return hit;
    }
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
  return FALLBACK;
}

let current: Locale = detectLocale();
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

function applyDocumentLang(): void {
  try {
    document.documentElement.lang = current;
  } catch {
    /* ignore */
  }
}

applyDocumentLang();

export function setLocale(locale: Locale): void {
  if (!LOCALES.includes(locale) || locale === current) return;
  current = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* ignore */
  }
  applyDocumentLang();
  for (const fn of listeners) fn();
}

function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 取译文：当前语言 → 兜底语言 → key 本身。
 * 空字符串算「还没翻译」，继续往下回退（翻译中途的骨架文件不会让界面变空白）。
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = RESOURCES[current]?.[key] || fallbackDict[key] || key;
  return interpolate(raw, params);
}

/** 只在有译文时返回，否则返回 null；用于「认不出就显示服务端原文」的场合 */
export function tOptional(key: string, params?: Record<string, string | number>): string | null {
  const raw = RESOURCES[current]?.[key] || fallbackDict[key];
  if (!raw) return null;
  return interpolate(raw, params);
}

function interpolate(raw: string, params?: Record<string, string | number>): string {
  if (!params) return raw;
  let out = raw;
  for (const [name, value] of Object.entries(params)) {
    out = out.split(`{${name}}`).join(String(value));
  }
  return out;
}

/** 组件里用这个，language 变化会触发重渲染 */
export function useI18n(): {
  t: typeof t;
  tOptional: typeof tOptional;
  locale: Locale;
  setLocale: (locale: Locale) => void;
} {
  const [locale, setLocaleState] = useState<Locale>(getLocale());
  useEffect(() => subscribeLocale(() => setLocaleState(getLocale())), []);
  return { t, tOptional, locale, setLocale };
}
