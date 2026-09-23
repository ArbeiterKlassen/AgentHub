import { useEffect, useState } from 'react';
import zhCN from '@/locales/zh-CN.json';
import enUS from '@/locales/en-US.json';

/**
 * 网页端本地化。
 *
 * 设计约束有三条。
 * 一，key 固定、value 是译文，放在 locales/*.json 里，改文案不动代码。
 * 二，locale 只存在浏览器本地，不参与任何服务端请求，接口契约与通信行为不变。
 * 三，认出 key 就本地化，认不出就原样显示（系统消息由服务端生成，必须允许回退）。
 */
export const LOCALES = ['zh-CN', 'en-US'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
};

const RESOURCES: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN as Record<string, string>,
  'en-US': enUS as Record<string, string>,
};

const STORAGE_KEY = 'agenthub-locale';
const FALLBACK: Locale = 'zh-CN';

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (LOCALES as readonly string[]).includes(saved)) return saved as Locale;
    const nav = navigator.language ?? '';
    if (/^en/i.test(nav)) return 'en-US';
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
  if (locale === current) return;
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

/** 取译文；缺 key 时退回中文，再退回 key 本身，便于开发期发现漏翻 */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = RESOURCES[current] ?? {};
  const raw = dict[key] ?? RESOURCES[FALLBACK][key] ?? key;
  return interpolate(raw, params);
}

/** 只在 key 存在时返回译文，否则返回 null；用于「认不出就显示服务端原文」的场合 */
export function tOptional(key: string, params?: Record<string, string | number>): string | null {
  const dict = RESOURCES[current] ?? {};
  const raw = dict[key] ?? RESOURCES[FALLBACK][key];
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
