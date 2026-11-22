import { vi } from 'vitest';
import type { CachedTranscript } from '../src/core/cache';

/**
 * 最小的 IndexedDB 假实现：只覆盖 `src/core/cache` 用到的 getAll / put / delete。
 *
 * 缓存层的行为（complete 闸门、归属守卫、站点命名空间）是纯数据判定，
 * 用内存 Map 足够；真正需要浏览器的是索引本身，不在测试范围内。
 */
export function installFakeIndexedDb(store: Map<string, CachedTranscript>): void {
  const request = <T>(result: T) => {
    const r: {
      result: T;
      error: null;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
    } = { result, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => r.onsuccess?.());
    return r;
  };

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

  vi.stubGlobal('indexedDB', {
    open: () => {
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
    },
  });
}
