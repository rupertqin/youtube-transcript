import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKey, readCacheForVideo, writeCache } from '../src/core/cache';
import type { CachedTranscript } from '../src/core/cache';
import type { TranscriptLine } from '../src/core/types';

/**
 * 「点清空缓存并重新抓取才拿到全部字幕」的根因：旧版把只含视口几十行的
 * DOM 快照当成成功结果写进了 7 天缓存。schema 8 一次性作废旧条目，
 * 并且从此只允许 complete 的全量结果落盘。
 */

const VIDEO = 'AAAAAAAAAAA';
const rows: TranscriptLine[] = [
  { start: 0, dur: 1_800, text: '第一句' },
  { start: 2_000, dur: 1_800, text: '第二句' },
  { start: 4_000, dur: 1_800, text: '第三句' },
];

const store = new Map<string, CachedTranscript>();

function request<T>(result: T) {
  const r: {
    result: T;
    error: null;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
  } = { result, error: null, onsuccess: null, onerror: null };
  // promisify() 在拿到 request 之后同步挂 onsuccess，微任务里触发即可
  queueMicrotask(() => r.onsuccess?.());
  return r;
}

const fakeDb = {
  objectStoreNames: { contains: () => true },
  createObjectStore: () => ({ createIndex: () => undefined }),
  transaction: () => ({
    objectStore: () => ({
      getAll: () => request([...store.values()]),
      put: (value: CachedTranscript) => {
        store.set(value.key, value);
        return request(undefined);
      },
      delete: (key: string) => {
        store.delete(key);
        return request(undefined);
      },
    }),
  }),
};

function fakeOpen() {
  const r: {
    result: typeof fakeDb;
    onupgradeneeded: (() => void) | null;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
  } = { result: fakeDb, onupgradeneeded: null, onsuccess: null, onerror: null };
  queueMicrotask(() => {
    r.onupgradeneeded?.();
    r.onsuccess?.();
  });
  return r;
}

beforeAll(() => {
  vi.stubGlobal('indexedDB', { open: fakeOpen });
});

beforeEach(() => {
  store.clear();
});

function entry(
  overrides: Partial<CachedTranscript> = {},
): Omit<CachedTranscript, 'expiresAt'> {
  return {
    key: cacheKey('youtube', VIDEO, 'en', 'asr'),
    site: 'youtube',
    videoId: VIDEO,
    lang: 'en',
    kind: 'asr',
    title: 'Demo',
    source: 'innertube',
    lines: rows,
    showTimestamps: true,
    savedAt: Date.now(),
    complete: true,
    ...overrides,
  };
}

describe('缓存可信标记', () => {
  it('cacheKey 用 schema 9 前缀 + 站点段，让历史残缺缓存整体失效', () => {
    expect(cacheKey('youtube', VIDEO, 'en', 'asr')).toBe('v9|youtube|AAAAAAAAAAA|en|asr');
  });

  it('complete=false 的 DOM 预览绝不落盘', async () => {
    await writeCache(entry({ complete: false }));
    expect(store.size).toBe(0);
  });

  it('完整结果写入后能被读回', async () => {
    await writeCache(entry());
    const hit = await readCacheForVideo('youtube', VIDEO);
    expect(hit?.videoId).toBe(VIDEO);
    expect(hit?.lines).toHaveLength(3);
    expect(hit?.complete).toBe(true);
  });

  it('库里残缺条目（旧版本留下的）不会被当成最终结果命中', async () => {
    const bad = entry({ complete: false }) as CachedTranscript;
    store.set(bad.key, { ...bad, expiresAt: Date.now() + 60_000 });
    expect(await readCacheForVideo('youtube', VIDEO)).toBeNull();
  });

  it('schema 7 的老条目一律不命中', async () => {
    const old = entry({ key: 'v7|AAAAAAAAAAA|en|asr' }) as CachedTranscript;
    store.set(old.key, { ...old, expiresAt: Date.now() + 60_000 });
    expect(await readCacheForVideo('youtube', VIDEO)).toBeNull();
  });

  it('归属守卫：播放器不在该视频上时拒绝写入', async () => {
    await writeCache(entry(), { playerVideoId: 'BBBBBBBBBBB' });
    expect(store.size).toBe(0);
  });

  it('选了中文就不会命中上次缓存的英文', async () => {
    await writeCache(entry());
    expect(await readCacheForVideo('youtube', VIDEO, 'zh-Hans')).toBeNull();
    expect(await readCacheForVideo('youtube', VIDEO, 'en')).not.toBeNull();
  });

  it('归属守卫：站点不符时拒绝写入', async () => {
    await writeCache(entry(), { site: 'bilibili' });
    expect(store.size).toBe(0);
  });
});
