import { looksLikeTranscript } from '../lines';
import type { Chapter, LogEvent, TranscriptLine } from '../types';

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * 缓存结构版本。调高即让所有旧条目失效：
 * v1 曾把「整页文本」当字幕写进来（推荐列表的时长徽标被误认成时间码）；
 * v2 又写进过「1 行 Transcript」（面板标题被当成唯一一行）。
 * v4 新增无障碍时长清洗与 chapters 字段，旧缓存里还带着
 * "33 minutes, 26 seconds"，必须抬版本让它失效。
 * v6 修复「内容归属」：早期版本在 SPA 切页窗口期把**上一个视频**的 DOM 字幕
 *    以**新视频**的 videoId 写进缓存。这种条目 id 对得上、内容却是别人的，
 *    单看 videoId 永远查不出来 —— 只能整体作废并靠 writeCache 的归属守卫防复发。
 * v7 同上：拦截层曾用「发请求时的地址栏」给 get_transcript 定归属，切页窗口期
 *    会把旧面板迟到的响应标成新视频，污染同样无法从 videoId 上发现。整体作废。
 * 每次调整判定规则都必须抬版本，否则修好代码也会一直读到旧脏数据。
 */
const CACHE_SCHEMA = 8;

const DB_NAME = 'ytt-cache';
const DB_VERSION = 1;
const STORE_TRANSCRIPTS = 'transcripts';
const STORE_EVENTS = 'events';

export interface CachedTranscript {
  key: string;
  videoId: string;
  lang: string;
  kind: string;
  title: string;
  source: string;
  lines: TranscriptLine[];
  /** 章节单独存，不参与 looksLikeTranscript 校验 */
  chapters?: Chapter[];
  showTimestamps: boolean;
  savedAt: number;
  expiresAt: number;
  /** 只有全量字幕才进缓存；DOM 预览（false）一律不写、不读 */
  complete?: boolean;
}

export function cacheKey(videoId: string, lang?: string | null, kind?: string | null): string {
  return `v${CACHE_SCHEMA}|${videoId}|${lang ?? 'na'}|${kind ?? 'manual'}`;
}

function available(): boolean {
  return typeof indexedDB !== 'undefined';
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!available()) return Promise.reject(new Error('indexedDB unavailable'));
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_TRANSCRIPTS)) {
        const store = db.createObjectStore(STORE_TRANSCRIPTS, { keyPath: 'key' });
        store.createIndex('videoId', 'videoId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_EVENTS)) {
        db.createObjectStore(STORE_EVENTS, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
  });

  return dbPromise;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
  });
}

/**
 * 读某条视频的缓存。
 *
 * preferredLang 是「产出语言」（选了中文就是 zh-Hans）：传了它就必须语言相符，
 * 否则「中文」会命中上次缓存的英文 —— 用户看到的语言和选择不一致，而且看不出来。
 * 不传（同音频模式）表示任何语言的条目都能用。
 */
export async function readCacheForVideo(
  videoId: string,
  preferredLang?: string | null,
): Promise<CachedTranscript | null> {
  if (!available()) return null;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_TRANSCRIPTS, 'readonly');
    const all = await promisify(tx.objectStore(STORE_TRANSCRIPTS).getAll() as IDBRequest<CachedTranscript[]>);
    const now = Date.now();
    const prefix = `v${CACHE_SCHEMA}|`;
    const hit = all
      .filter(
        (entry) =>
          entry.videoId === videoId &&
          (!preferredLang || entry.lang === preferredLang) &&
          entry.key.startsWith(prefix) &&
          entry.expiresAt > now &&
          entry.lines.length > 0 &&
          // 残缺预览不该命中为最终结果；schema 8 之前的老缓存已被 key 前缀挡掉
          entry.complete !== false,
      )
      .sort((a, b) => (a.kind === 'asr' ? 1 : 0) - (b.kind === 'asr' ? 1 : 0) || b.savedAt - a.savedAt)[0];
    if (!hit) return null;

    // 读的时候再校验一次：旧版本可能写进了「页面文本」
    if (!looksLikeTranscript(hit.lines)) {
      await drop(hit.key);
      console.warn('[ytt] dropped cache entry that does not look like a transcript', hit.key);
      return null;
    }
    return hit;
  } catch (error) {
    console.warn('[ytt] cache read failed', error);
    return null;
  }
}

/** 删除单条缓存（脏数据、过期数据、串了视频的内容）。 */
export async function dropCacheEntry(key: string): Promise<void> {
  await drop(key);
}

async function drop(key: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_TRANSCRIPTS, 'readwrite');
    tx.objectStore(STORE_TRANSCRIPTS).delete(key);
  } catch {
    /* ignore */
  }
}

/**
 * 写入缓存。
 *
 * `guard.playerVideoId` 是**抓取当时播放器在播哪个视频**。和 entry.videoId 不一致
 * 就拒绝写入：那说明这份内容属于别的视频，存进去就会变成「id 对、内容错」的
 * 条目，之后每次命中都拿到别人的字幕，而且永远查不出原因。
 */
export async function writeCache(
  entry: Omit<CachedTranscript, 'expiresAt'>,
  guard?: { playerVideoId?: string | null },
): Promise<void> {
  if (!available()) return;
  // DOM 预览只有视口里的几十行，写进去就会把「缺前段」固化 7 天
  if (entry.complete === false) {
    console.warn('[ytt] skip caching: incomplete preview');
    return;
  }
  // 写之前把不合法内容挡掉，避免脏数据再存活 7 天
  if (!looksLikeTranscript(entry.lines)) {
    console.warn('[ytt] skip caching: lines do not look like a transcript');
    return;
  }
  const declared = guard?.playerVideoId;
  if (declared && declared !== entry.videoId) {
    console.warn('[ytt] skip caching: content belongs to another video', declared, entry.videoId);
    return;
  }
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_TRANSCRIPTS, 'readwrite');
    // key 统一由 cacheKey 生成，避免调用方各写一套格式
    tx.objectStore(STORE_TRANSCRIPTS).put({
      ...entry,
      key: cacheKey(entry.videoId, entry.lang, entry.kind),
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  } catch (error) {
    console.warn('[ytt] cache write failed', error);
  }
}

export async function pruneCache(): Promise<void> {
  if (!available()) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_TRANSCRIPTS, 'readwrite');
    const store = tx.objectStore(STORE_TRANSCRIPTS);
    const all = await promisify(store.getAll() as IDBRequest<CachedTranscript[]>);
    const now = Date.now();
    for (const entry of all) {
      if (entry.expiresAt <= now) store.delete(entry.key);
    }
  } catch {
    /* 清理失败不影响使用 */
  }
}

export async function clearCache(): Promise<void> {
  if (!available()) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_TRANSCRIPTS, 'readwrite');
    tx.objectStore(STORE_TRANSCRIPTS).clear();
  } catch {
    /* ignore */
  }
}

/** 诊断事件：只留层名/耗时/错误码，永不落字幕正文。 */
export async function logDiagnostic(event: Omit<LogEvent, 'at'> & { at?: number }): Promise<void> {
  if (!available()) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_EVENTS, 'readwrite');
    tx.objectStore(STORE_EVENTS).add({ ...event, at: event.at ?? Date.now() });
  } catch {
    /* ignore */
  }
}

export async function readDiagnostics(limit = 100): Promise<LogEvent[]> {
  if (!available()) return [];
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_EVENTS, 'readonly');
    const all = await promisify(tx.objectStore(STORE_EVENTS).getAll() as IDBRequest<LogEvent[]>);
    return all.slice(-limit).reverse();
  } catch {
    return [];
  }
}
