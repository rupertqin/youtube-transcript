import type { PanelState } from './types';

export interface Store<T extends object> {
  getState(): T;
  setState(patch: Partial<T> | ((state: T) => Partial<T>)): void;
  subscribe(listener: (state: T) => void): () => void;
}

function shallowEqual<T extends object>(a: T, b: T): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key]);
}

/** 极简 store：面板与宿主共用同一份状态，不需要引入状态库。 */
export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<(state: T) => void>();

  return {
    getState: () => state,
    setState(patch) {
      const next = typeof patch === 'function' ? (patch as (state: T) => Partial<T>)(state) : patch;
      const merged = { ...state, ...next };
      if (shallowEqual(state, merged)) return;
      state = merged;
      for (const listener of [...listeners]) {
        try {
          listener(state);
        } catch (error) {
          console.error('[ytt] store listener failed', error);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function emptyPanelState(videoId = '', site = ''): PanelState {
  return {
    videoId,
    site,
    sourceUrl: null,
    title: '',
    status: 'idle',
    lines: [],
    chapters: [],
    storyboard: null,
    showTimestamps: true,
    source: null,
    lang: null,
    trackLabel: null,
    availableLangs: [],
    cached: false,
    complete: true,
    mergeStats: null,
    failures: [],
    error: null,
    activeIndex: -1,
    positionMs: -1,
    updatedAt: 0,
    progress: null,
    diagnostic: null,
  };
}
