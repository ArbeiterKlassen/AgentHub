export type ThemeName = 'light' | 'dark';

/** 切换瞬间挂在 <html> 上的过渡类，见 index.css */
const TRANSITION_CLASS = 'theme-transition';
const TRANSITION_MS = 320;

let clearTimer: number | null = null;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * 给整页挂一个短命的过渡类，让主题切换做颜色插值而不是瞬间闪屏。
 * 先加类再改 .dark，并强制一次样式计算，保证过渡在同一帧就被浏览器登记。
 */
export function startThemeTransition(ms = TRANSITION_MS): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (prefersReducedMotion()) return;
  root.classList.add(TRANSITION_CLASS);
  // 强制样式重算（读取布局属性即可），否则同帧内的两次 class 变更可能被合并
  void root.offsetHeight;
  if (clearTimer !== null) window.clearTimeout(clearTimer);
  clearTimer = window.setTimeout(() => {
    root.classList.remove(TRANSITION_CLASS);
    clearTimer = null;
  }, ms);
}

/** 同步 <html> 的主题类与原生控件配色（滚动条、输入框、select） */
export function applyThemeClass(theme: ThemeName): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

/** 首屏用：在 React 挂载前先把持久化的主题贴上，避免"先白后黑" */
export function bootstrapThemeFromStorage(key = 'agenthub-ui'): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { state?: { theme?: ThemeName } };
    const theme = parsed?.state?.theme;
    if (theme === 'dark' || theme === 'light') applyThemeClass(theme);
  } catch {
    /* localStorage 不可用或内容损坏时忽略，交给 store 的默认值 */
  }
}
