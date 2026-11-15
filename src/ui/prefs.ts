import type { LangChoice } from '../core/langs';
import type { ContentView } from '../core/types';

export type ThemePref = 'system' | 'light' | 'dark';

export interface Prefs {
  theme: ThemePref;
  /** 显示与复制是否带时间戳 */
  timestamps: boolean;
  /** lines = 字幕，chapters = 章节；两个入口共用 */
  view: ContentView;
  /** 想要哪种语言的字幕：auto = 同音频（原声轨道） */
  lang: LangChoice;
  /**
   * 目标语言拿不到时，是否允许我们**主动把播放器的 CC 轨道切过去**，
   * 截下播放器自己算好 POT 的 timedtext，然后再切回来（字幕会短暂出现一下）。
   */
  autoSwitchTrack: boolean;
}

const DEFAULT_PREFS: Prefs = {
  theme: 'dark',
  timestamps: true,
  view: 'lines',
  lang: 'auto',
  // 默认开：多语言就这一条能自动拿到「非默认轨道」全文的路径，关掉就只能手动切
  autoSwitchTrack: true,
};
const STORAGE_KEY = 'ytt-prefs';

/**
 * 落盘。
 *
 * 偏好只落一处：扩展走 chrome.storage，油猴走 localStorage。
 */
function persistLocal(prefs: Prefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* 扩展的 isolated world 里可能没有 localStorage，chrome.storage 会兜住 */
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
    persistLocal(cached);
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
        persistLocal(cached);
        notify();
      }
      return;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      cached = { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
      persistLocal(cached);
      notify();
    }
  } catch {
    /* 读不到就用默认值 */
  }
  persistLocal(cached);
}

export function setPrefs(patch: Partial<Prefs>): void {
  cached = { ...cached, ...patch };
  persistLocal(cached);
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
