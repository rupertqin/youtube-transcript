export type ThemePref = 'system' | 'light' | 'dark';

export interface Prefs {
  theme: ThemePref;
  timestamps: boolean;
}

const DEFAULT_PREFS: Prefs = { theme: 'dark', timestamps: true };
const STORAGE_KEY = 'ytt-prefs';

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
        notify();
      }
      return;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      cached = { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
      notify();
    }
  } catch {
    /* 读不到就用默认值 */
  }
}

export function setPrefs(patch: Partial<Prefs>): void {
  cached = { ...cached, ...patch };
  notify();
  try {
    const store = chromeStorage();
    if (store) void store.set({ [STORAGE_KEY]: cached });
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
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
