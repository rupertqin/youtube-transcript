import type { ErrorCode, Logger } from '../../types';
import { biliError } from './errors';
import type { BiliTrack } from './parse';
import { keyFromUrl, signWbi } from './wbi';

/**
 * B 站接口客户端。
 *
 * 用**页面上下文**的 fetch（`credentials:'include'`）而不是 GM_xmlhttpRequest：
 * 油猴脚本必须保持 `@grant none`（一旦有 grant 就会被沙箱化，YouTube 那边的
 * `#movie_player.getPlayerResponse()` 与 fetch hook 全废）。扩展端则靠
 * `host_permissions` 拿到同样的豁免。
 */

const TIMEOUT_MS = 20_000;
/** WBI key 10 分钟有效；缓存 9 分钟，避免边界上用到刚过期的。 */
const WBI_TTL_MS = 9 * 60 * 1000;
/** 视频信息 / 轨道列表只用于「同一页面的多次调用」，短缓存即可。 */
const SHORT_TTL_MS = 60 * 1000;

const API = 'https://api.bilibili.com';

export interface BiliPage {
  cid: number;
  page: number;
  part?: string;
}

export interface BiliView {
  bvid: string;
  aid: number;
  title: string;
  /** 秒 */
  duration: number;
  pages: BiliPage[];
}

export interface BiliApiOptions {
  win: Window;
  log: Logger;
  fetchFn?: typeof fetch;
  now?: () => number;
}

interface ApiEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

export interface BiliApi {
  /** 视频基础信息（含分 P 列表） */
  view(bvid: string, signal: AbortSignal): Promise<BiliView>;
  /** 全部字幕轨（投稿 + AI）。需要登录态。 */
  tracks(bvid: string, cid: number, signal: AbortSignal): Promise<BiliTrack[]>;
  /** 字幕正文（`{ body: [...] }`）；auth_key 约 7 分钟过期，不缓存 */
  subtitle(url: string, signal: AbortSignal): Promise<unknown>;
  /** 上次拿到的轨道（同步读，给 availableLangs 用） */
  peekTracks(cacheId: string): BiliTrack[] | null;
  /** 页面状态里已经带了轨道列表时记下来，省一次 WBI 请求 */
  rememberTracks(cacheId: string, tracks: BiliTrack[]): void;
  reset(): void;
}

/** 带上 `code` 字段，`harvestTranscript` 的 step 能直接把它当错误码用。 */
export class BiliApiError extends Error {
  readonly code: ErrorCode;
  readonly biliCode: number | undefined;

  constructor(biliCode: number | undefined, message?: string) {
    const mapped = biliError(biliCode, message);
    super(mapped.detail);
    this.name = 'BiliApiError';
    this.biliCode = biliCode;
    this.code = mapped.code;
  }
}

function envelope(raw: unknown): { code?: number; message?: string; data?: unknown } {
  if (!raw || typeof raw !== 'object') return {};
  const item = raw as ApiEnvelope<unknown>;
  return { code: item.code, message: item.message, data: item.data };
}

export function createBiliApi(options: BiliApiOptions): BiliApi {
  const { win, log } = options;
  const now = options.now ?? (() => Date.now());
  const fetchFn =
    options.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => win.fetch(input, init));

  let wbi: { imgKey: string; subKey: string; at: number } | null = null;
  const viewCache = new Map<string, { at: number; value: BiliView }>();
  const trackCache = new Map<string, { at: number; value: BiliTrack[] }>();

  async function requestJson(
    url: string,
    signal?: AbortSignal,
    credentials: RequestCredentials = 'include',
  ): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetchFn(url, {
        credentials,
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'NETWORK_ERROR' as ErrorCode });
      }
      return await response.json();
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) throw error;
      // fetch 只在网络层失败时抛；页面内最常见的形态是 CORS/CSP 被挡
      throw Object.assign(
        new Error(
          `请求 ${url} 失败：${String(error)}。` +
            '若网络正常，多半是页面内 fetch 被 CORS/CSP 拦了 —— 确认已登录后重试',
        ),
        { code: 'NETWORK_ERROR' as ErrorCode },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function ensureWbiKeys(signal?: AbortSignal): Promise<{ imgKey: string; subKey: string }> {
    if (wbi && now() - wbi.at < WBI_TTL_MS) return wbi;
    const raw = await requestJson(`${API}/x/web-interface/nav`, signal);
    // 未登录时 code = -101，但 data.wbi_img 依然可用 —— 不能因为 code 就放弃
    const meta = envelope(raw);
    const img = (meta.data as { wbi_img?: { img_url?: string; sub_url?: string } } | undefined)?.wbi_img;
    if (!img?.img_url || !img?.sub_url) throw new BiliApiError(meta.code, meta.message);
    wbi = { imgKey: keyFromUrl(img.img_url), subKey: keyFromUrl(img.sub_url), at: now() };
    return wbi;
  }

  return {
    async view(bvid, signal) {
      const cached = viewCache.get(bvid);
      if (cached && now() - cached.at < SHORT_TTL_MS) return cached.value;

      const raw = await requestJson(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, signal);
      const meta = envelope(raw);
      if (meta.code !== 0) throw new BiliApiError(meta.code, meta.message);

      const data = meta.data as
        | {
            bvid?: string;
            aid?: number;
            title?: string;
            duration?: number;
            pages?: Array<{ cid?: number; page?: number; part?: string }>;
          }
        | undefined;
      if (!data?.bvid) throw new BiliApiError(meta.code, '返回里没有 bvid');

      const value: BiliView = {
        bvid: data.bvid,
        aid: Number(data.aid) || 0,
        title: data.title ?? bvid,
        duration: Number(data.duration) || 0,
        pages: (data.pages ?? [])
          .map((page) => ({
            cid: Number(page.cid) || 0,
            page: Number(page.page) || 1,
            part: page.part,
          }))
          .filter((page) => page.cid > 0),
      };
      viewCache.set(bvid, { at: now(), value });
      return value;
    },

    async tracks(bvid, cid, signal) {
      const cacheId = `${bvid}|${cid}`;
      const cached = trackCache.get(cacheId);
      if (cached && now() - cached.at < SHORT_TTL_MS) return cached.value;

      const keys = await ensureWbiKeys(signal);
      const query = signWbi({ bvid, cid }, keys.imgKey, keys.subKey, now());
      const raw = await requestJson(`${API}/x/player/wbi/v2?${query}`, signal);
      const meta = envelope(raw);
      if (meta.code !== 0) throw new BiliApiError(meta.code, meta.message);

      const subtitles = (meta.data as { subtitle?: { subtitles?: BiliTrack[] } } | undefined)?.subtitle
        ?.subtitles;
      const list = Array.isArray(subtitles) ? subtitles : [];
      trackCache.set(cacheId, { at: now(), value: list });
      log({ code: 'OK', source: 'player', meta: { site: 'bilibili', tracks: list.length } });
      return list;
    },

    async subtitle(url, signal) {
      if (!url) throw new BiliApiError(undefined, 'subtitle_url 为空（AI 字幕仍在生成）');
      const target = url.startsWith('//') ? `https:${url}` : url;
      // 字幕 CDN 的 CORS 头在部分环境下不允许带 cookie；URL 本身带 auth_key，
      // 所以失败后用 omit 再试一次（扩展端有 host_permissions，第一次就会成功）。
      try {
        return await requestJson(target, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        return requestJson(target, signal, 'omit');
      }
    },

    peekTracks: (cacheId) => trackCache.get(cacheId)?.value ?? null,
    rememberTracks: (cacheId, tracks) => trackCache.set(cacheId, { at: now(), value: tracks }),
    reset() {
      viewCache.clear();
      trackCache.clear();
    },
  };
}
