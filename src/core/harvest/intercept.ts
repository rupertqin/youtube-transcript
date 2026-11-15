import { readPlayerVideoId } from './player';
import { langFromGetTranscriptBody, videoIdFromGetTranscriptBody } from './parse/transcript';
import {
  isGetPanelUrl,
  isGetTranscriptUrl,
  isTimedTextUrl,
  langFromTimedTextUrl,
  videoIdFromTimedTextUrl,
} from './timedtext';

export type CaptureKind = 'timedtext' | 'get_transcript' | 'get_panel';

/**
 * 打在我们自己发起的请求上的标记。
 *
 * hook 补的是全局 `window.fetch`，所以我们自己直连 `get_panel` 的请求
 * **也会被截下来**。失败时截到的是 119 字符的 400 错误体，它会把捕获缓存污染成
 * 「已有一条 get_transcript 响应」—— 于是拦截层 0ms 命中垃圾、解析出 0 行，
 * 真正的面板响应反而等不到。自己发的请求不截。
 */
export const SELF_FETCH = Symbol.for('ytt.self-fetch');

function captureKind(url: string, bodyHint?: unknown): CaptureKind | null {
  if (isTimedTextUrl(url)) return 'timedtext';
  if (isGetTranscriptUrl(url)) return 'get_transcript';
  // get_panel 承载很多面板（评论、章节…），只有字幕那个才截
  if (isGetPanelUrl(url)) {
    const body = typeof bodyHint === 'string' ? bodyHint : '';
    return /transcript/iu.test(body) ? 'get_panel' : null;
  }
  return null;
}

export interface TimedTextCapture {
  url: string;
  kind: CaptureKind;
  videoId: string | null;
  lang: string | null;
  text: string;
  at: number;
}

export interface TimedTextHook {
  /** 已捕获的响应，按时间倒序 */
  captures(): TimedTextCapture[];
  latest(videoId?: string): TimedTextCapture | null;
  /** 等待一条属于 videoId 的新响应（会先检查历史捕获） */
  waitFor(videoId: string, timeoutMs: number): Promise<TimedTextCapture | null>;
  /**
   * 等待一条**满足条件**的响应（会先检查历史捕获）。
   *
   * `waitFor` 只要视频对得上就立即返回，切语言时会把手上那条英文顶回来；
   * 这里按语言过滤，用户切一次 CC 语言后才算命中。
   */
  waitForMatch?(
    videoId: string,
    match: (capture: TimedTextCapture) => boolean,
    timeoutMs: number,
  ): Promise<TimedTextCapture | null>;
  /** 订阅实时捕获：用户手动打开原生面板时，YouTube 会自己发请求 */
  onCapture(listener: (capture: TimedTextCapture) => void): () => void;
  dispose(): void;
  installedAt: number;
}

const HOOK_KEY = '__yttTimedTextHookV1';
const URL_KEY = '__yttXhrUrl';
const MAX_CAPTURES = 8;

interface Waiter {
  videoId: string;
  /** 有它时只有满足条件的捕获才会唤醒（切语言场景） */
  match?: (capture: TimedTextCapture) => boolean;
  resolve: (capture: TimedTextCapture | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 归属兜底：先信播放器，再退地址栏。
 *
 * SPA 切页时地址栏先变、播放器后变，而原生字幕面板属于**播放器**。
 * 只用地址栏的话，旧面板迟到的请求会被标成新视频，于是新视频一打开
 * 就显示上一个视频的字幕 —— 而且 videoId 完全对得上。
 */
function ownerVideoId(win: Window): string | null {
  try {
    return readPlayerVideoId(win) ?? videoIdFromLocation(win);
  } catch {
    return videoIdFromLocation(win);
  }
}

export function videoIdFromLocation(win: Window): string | null {
  try {
    const href = win.location?.href ?? '';
    const match = /[?&]v=([\w-]{11})/u.exec(href) ?? /\/shorts\/([\w-]{11})/u.exec(href);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === 'object' && 'url' in input) return String((input as Request).url);
  return '';
}

/**
 * 被动拦截：YouTube 自己请求 timedtext 时把响应 clone 一份下来。
 * 这样拿到的是播放器已经算好 POT 的结果，比我们裸请求可靠。
 *
 * 必须在 document_start 装 —— 晚装会漏掉播放器首帧请求。
 */
export function installTimedTextHook(win: Window): TimedTextHook {
  const scope = win as unknown as Record<string, unknown>;
  const existing = scope[HOOK_KEY] as TimedTextHook | undefined;
  if (existing) return existing;

  const store: TimedTextCapture[] = [];
  const waiters = new Set<Waiter>();
  const listeners = new Set<(capture: TimedTextCapture) => void>();
  const seen = new Set<string>();

  const notify = (capture: TimedTextCapture) => {
    for (const waiter of [...waiters]) {
      // 归属未知的 capture 不能作为任何视频的命中：宁可超时走下一层，
      // 也不能把别的视频的字幕当成当前视频返回。
      if (!capture.videoId || capture.videoId !== waiter.videoId) continue;
      // 指定了语言（切语言场景）：语言不符的那条不唤醒，继续等
      if (waiter.match && !waiter.match(capture)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(capture);
    }
  };

  const record = (
    url: string,
    text: string,
    kind: CaptureKind,
    bodyHint?: unknown,
    /** 请求**发出那一刻**的地址栏视频 id，由调用方在发起请求时同步取好 */
    atRequestVideoId?: string | null,
  ) => {
    if (!text || !text.trim()) return;
    const fingerprint = `${url}#${text.length}#${text.slice(0, 24)}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);

    const capture: TimedTextCapture = {
      url,
      kind,
      // get_transcript 的 videoId 在 POST body 里（protobuf params），URL 上认不出来。
      // 关键：地址栏兜底必须用**请求发出时**的 id，不能用响应到达时的 ——
      // 切页时请求属于旧视频、响应却在新地址栏下到达，用后者会把归属整体搞错。
      videoId:
        kind === 'timedtext'
          ? videoIdFromTimedTextUrl(url)
          : (videoIdFromGetTranscriptBody(bodyHint) ??
            atRequestVideoId ??
            videoIdFromTimedTextUrl(url)),
      // get_transcript 的 URL 上没有 lang=，语言码在 params 里；
      // 读不到就是 null，绝不能当「未知语言」去否决完整响应。
      lang:
        kind === 'timedtext'
          ? langFromTimedTextUrl(url)
          : (langFromGetTranscriptBody(bodyHint) ?? null),
      text,
      at: Date.now(),
    };
    store.unshift(capture);
    if (store.length > MAX_CAPTURES) store.pop();
    notify(capture);
    for (const listener of [...listeners]) {
      try {
        listener(capture);
      } catch {
        /* 订阅者出错不影响拦截 */
      }
    }
  };

  const waitUntil = (
    videoId: string,
    match: ((capture: TimedTextCapture) => boolean) | undefined,
    timeoutMs: number,
  ): Promise<TimedTextCapture | null> =>
    new Promise<TimedTextCapture | null>((resolve) => {
      const waiter: Waiter = {
        videoId,
        match,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          resolve(null);
        }, Math.max(0, timeoutMs)),
      };
      waiters.add(waiter);
    });

  const hook: TimedTextHook = {
    installedAt: Date.now(),
    captures: () => [...store],
    latest(videoId?: string) {
      if (!videoId) return store[0] ?? null;
      return store.find((capture) => capture.videoId === videoId) ?? null;
    },
    waitFor(videoId: string, timeoutMs: number) {
      const cached = hook.latest(videoId);
      if (cached) return Promise.resolve(cached);
      return waitUntil(videoId, undefined, timeoutMs);
    },
    waitForMatch(
      videoId: string,
      match: (capture: TimedTextCapture) => boolean,
      timeoutMs: number,
    ) {
      // 历史捕获里已经有满足条件的：0ms 命中（用户先切语言、再点抓取）
      const cached = store.find(
        (capture) => capture.videoId === videoId && match(capture),
      );
      if (cached) return Promise.resolve(cached);
      return waitUntil(videoId, match, timeoutMs);
    },
    onCapture(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
      waiters.clear();
      delete scope[HOOK_KEY];
    },
  };

  // ---- fetch ----
  const originalFetch = win.fetch;
  if (typeof originalFetch === 'function') {
    win.fetch = function patchedFetch(this: unknown, ...args: Parameters<typeof fetch>) {
      const promise = originalFetch.apply(this ?? win, args);
      const init = args[1] as (RequestInit & Record<symbol, unknown>) | undefined;
      // 自己发的请求不截：失败时那条错误体会污染捕获缓存
      if (init?.[SELF_FETCH]) return promise;
      const url = requestUrl(args[0]);
      const bodyHint = init?.body;
      const kind = captureKind(url, bodyHint);
      if (kind) {
        // 同步取：请求属于哪个视频由「发出这一刻」的播放器决定（播放器才拥有这个面板）
        const atRequest = ownerVideoId(win);
        promise
          .then((response) => {
            // 错误响应（400/403…）不是字幕，截下来只会变成「119 字符解析出 0 行」。
            // 只在**确实报了错误**时跳过：`ok` 缺失（测试桩 / 老实现）时照旧截获。
            if (response?.ok === false) return;
            const clone = response.clone();
            clone
              .text()
              .then((text) => record(url, text, kind, bodyHint, atRequest))
              .catch(() => undefined);
          })
          .catch(() => undefined);
      }
      return promise;
    } as typeof fetch;
  }

  // ---- XMLHttpRequest ----
  const XhrCtor = (win as unknown as typeof globalThis).XMLHttpRequest as (new () => XMLHttpRequest) | undefined;
  const proto = XhrCtor?.prototype as unknown as
    | {
        open: (...args: never[]) => void;
        send: (...args: never[]) => void;
      }
    | undefined;

  if (proto) {
    const originalOpen = proto.open;
    const originalSend = proto.send;

    proto.open = function patchedOpen(
      this: XMLHttpRequest & Record<string, unknown>,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      this[URL_KEY] = String(url);
      return (originalOpen as unknown as (...args: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof proto.open;

    proto.send = function patchedSend(this: XMLHttpRequest & Record<string, unknown>, ...args: unknown[]) {
      const url = String(this[URL_KEY] ?? '');
      const bodyHint = args[0];
      const kind = captureKind(url, bodyHint);
      if (kind) {
        // 同 fetch：归属以「发出请求时」的播放器为准
        const atRequest = ownerVideoId(win);
        this.addEventListener('load', () => {
          // 同 fetch：错误响应不是字幕（status 0 是测试桩/未设，不拦）
          if (this.status && (this.status < 200 || this.status >= 300)) return;
          try {
            const text = this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText;
            if (typeof text === 'string') record(url, text, kind, bodyHint, atRequest);
          } catch {
            /* responseType 为 arraybuffer 时读不到文本，忽略 */
          }
        });
      }
      return (originalSend as unknown as (...args: unknown[]) => void).apply(this, args);
    } as typeof proto.send;
  }

  scope[HOOK_KEY] = hook;
  return hook;
}
