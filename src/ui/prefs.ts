import type { ContentView } from '../core/types';
import type { SharedPrefs } from '../legacy/contract';

export type ThemePref = 'system' | 'light' | 'dark';

export interface Prefs {
  theme: ThemePref;
  /** 显示与复制是否带时间戳 */
  timestamps: boolean;
  /** lines = 字幕，chapters = 章节；两个入口共用 */
  view: ContentView;
}

const DEFAULT_PREFS: Prefs = {
  theme: 'dark',
  timestamps: true,
  view: 'lines',
};
const STORAGE_KEY = 'ytt-prefs';

/**
 * 1.x 原版按钮是独立 IIFE，读不到本模块的内存态；
 * 每次变更都同步写一份到 globalThis，两个入口因此共用同一设置。
 */
function publishShared(prefs: Prefs): void {
  const shared: SharedPrefs = {
    timestamps: prefs.timestamps,
    view: prefs.view,
  };
  globalThis.__yttSharedPrefs = shared;
  // 原版按钮的 Shift/Alt 快捷切换走这个钩子，改完后新版 UI 也会重渲染
  globalThis.__yttSetSharedPrefs = (patch) => setPrefs(patch);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...cached, ...shared }));
  } catch {
    /* 扩展的 isolated world 里可能没有 localStorage，globalThis 已足够 */
  }
}

let cached: Prefs = { ...DEFAULT_PREFS };
let loaded = false;
const listeners = new Set<() => void>();

function chromeStorage(): chrome.storage.StorageArea | null {
  const api = typeof chrome !== 'undefined' ? chrome : undefined;
  return api?.storage?.local ?? null;
}

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/**
 * 扩展里侧栏与 content script 是两个 document：侧栏改了偏好，
 * 页面里那个原版按钮未必能立刻看到。监听存储变化把它们对齐。
 */
try {
  const api = typeof chrome !== 'undefined' ? chrome : undefined;
  api?.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    const value = changes[STORAGE_KEY].newValue as Partial<Prefs> | undefined;
    cached = { ...DEFAULT_PREFS, ...value };
    publishShared(cached);
    notify();
  });
} catch {
  /* 油猴端没有 chrome.storage */
}

export function getPrefs(): Prefs {
  return cached;
}

export function subscribePrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function loadPrefs(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const store = chromeStorage();
    if (store) {
      const result = await store.get(STORAGE_KEY);
      const value = result?.[STORAGE_KEY] as Partial<Prefs> | undefined;
      if (value) {
        cached = { ...DEFAULT_PREFS, ...value };
        publishShared(cached);
        notify();
      }
      return;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      cached = { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
      publishShared(cached);
      notify();
    }
  } catch {
    /* 读不到就用默认值 */
  }
  publishShared(cached);
}

export function setPrefs(patch: Partial<Prefs>): void {
  cached = { ...cached, ...patch };
  publishShared(cached);
  notify();
  try {
    const store = chromeStorage();
    if (store) void store.set({ [STORAGE_KEY]: cached });
  } catch {
    /* 写失败不影响当前会话 */
  }
}

export function resolveTheme(theme: ThemePref): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  if (typeof matchMedia !== 'function') return 'dark';
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** 跟随系统时也要对系统切换做出反应。 */
export function onThemeResolved(theme: ThemePref, apply: (resolved: 'light' | 'dark') => void): () => void {
  apply(resolveTheme(theme));
  if (theme !== 'system' || typeof matchMedia !== 'function') return () => undefined;
  const media = matchMedia('(prefers-color-scheme: light)');
  const onChange = () => apply(resolveTheme(theme));
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
