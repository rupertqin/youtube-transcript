import { videoIdFromGetTranscriptBody } from './parse/transcript';
import {
  isGetTranscriptUrl,
  isTimedTextUrl,
  langFromTimedTextUrl,
  videoIdFromTimedTextUrl,
} from './timedtext';

export type CaptureKind = 'timedtext' | 'get_transcript';

function captureKind(url: string): CaptureKind | null {
  if (isTimedTextUrl(url)) return 'timedtext';
  if (isGetTranscriptUrl(url)) return 'get_transcript';
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
  resolve: (capture: TimedTextCapture | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** get_transcript 的 POST body 里没有 videoId（它在 protobuf params 里），只能从当前页 URL 取。 */
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
      if (waiter.videoId && capture.videoId && waiter.videoId !== capture.videoId) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(capture);
    }
  };

  const record = (url: string, text: string, kind: CaptureKind, bodyHint?: unknown) => {
    if (!text || !text.trim()) return;
    const fingerprint = `${url}#${text.length}#${text.slice(0, 24)}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);

    const capture: TimedTextCapture = {
      url,
      kind,
      // get_transcript 的 videoId 在 POST body 里，URL 上认不出来
      videoId:
        kind === 'get_transcript'
          ? (videoIdFromGetTranscriptBody(bodyHint) ??
            videoIdFromLocation(win) ??
            videoIdFromTimedTextUrl(url))
          : videoIdFromTimedTextUrl(url),
      lang: langFromTimedTextUrl(url),
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
      return new Promise<TimedTextCapture | null>((resolve) => {
        const waiter: Waiter = {
          videoId,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            resolve(null);
          }, Math.max(0, timeoutMs)),
        };
        waiters.add(waiter);
      });
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
      const url = requestUrl(args[0]);
      const kind = captureKind(url);
      if (kind) {
        const bodyHint = (args[1] as RequestInit | undefined)?.body;
        promise
          .then((response) => {
            const clone = response.clone();
            clone
              .text()
              .then((text) => record(url, text, kind, bodyHint))
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
      const kind = captureKind(url);
      if (kind) {
        const bodyHint = args[0];
        this.addEventListener('load', () => {
          try {
            const text = this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText;
            if (typeof text === 'string') record(url, text, kind, bodyHint);
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
