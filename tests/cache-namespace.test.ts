import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cacheKey, readCacheForVideo, writeCache, type CachedTranscript } from '../src/core/cache';
import { installFakeIndexedDb } from './fake-idb';

/**
 * 站点命名空间。
 *
 * 两站的 videoId 形态不同，但「恰好同 id」并非不可能；真正危险的是
 * **同一个 id 在不同站点的字幕完全不同** —— 一旦互相命中，用户看到的是
 * 另一个视频的文字，而 videoId 校验还会放行。
 */

const store = new Map<string, CachedTranscript>();
beforeAll(() => installFakeIndexedDb(store));
beforeEach(() => store.clear());

// 至少三行、时间递增：cache.ts 的 looksLikeTranscript 会挡掉「一行/整页文本」
const rows = [
  { start: 0, dur: 1_800, text: '第一句' },
  { start: 2_000, dur: 1_800, text: '第二句' },
  { start: 4_000, dur: 1_800, text: '第三句' },
];

function entry(site: string, videoId: string): Parameters<typeof writeCache>[0] {
  return {
    site,
    videoId,
    lang: 'zh-Hans',
    kind: 'manual',
    title: 'Demo',
    source: 'innertube',
    lines: rows,
    showTimestamps: true,
    savedAt: Date.now(),
    complete: true,
  };
}

describe('缓存站点命名空间', () => {
  it('key 由 schema + 站点 + videoId + 语言 + kind 组成', () => {
    expect(cacheKey('bilibili', 'BV1xx411c7mD')).toBe('v9|bilibili|BV1xx411c7mD|na|manual');
    expect(cacheKey('youtube', 'BV1xx411c7mD', 'en', 'asr')).toBe('v9|youtube|BV1xx411c7mD|en|asr');
  });

  it('同一个 videoId 在两站各存各的，互不命中', async () => {
    const id = 'SAMEID12345';
    await writeCache(entry('youtube', id));
    await writeCache(entry('bilibili', id));
    expect(store.size).toBe(2);

    const yt = await readCacheForVideo('youtube', id);
    const bili = await readCacheForVideo('bilibili', id);
    expect(yt?.site).toBe('youtube');
    expect(bili?.site).toBe('bilibili');
  });

  it('只有一站缓存时，另一站读不到', async () => {
    await writeCache(entry('bilibili', 'BV1xx411c7mD'));
    expect(await readCacheForVideo('youtube', 'BV1xx411c7mD')).toBeNull();
    expect(await readCacheForVideo('bilibili', 'BV1xx411c7mD')).not.toBeNull();
  });

  it('schema 8 及更早的条目一律不命中（key 里没有站点段）', async () => {
    const legacy = {
      ...entry('youtube', 'AAAAAAAAAAA'),
      key: 'v8|AAAAAAAAAAA|zh-Hans|manual',
      expiresAt: Date.now() + 60_000,
    } as CachedTranscript;
    store.set(legacy.key, legacy);
    expect(await readCacheForVideo('youtube', 'AAAAAAAAAAA')).toBeNull();
  });
});
