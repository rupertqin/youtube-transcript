import type { CaptionTrack, ErrorCode, LineFormat, TranscriptLine } from '../types';
import { isBlockedPayload, parseJson3, parseSrv } from './parse';

export const TIMEDTEXT_PATH = '/api/timedtext';
/** 2026 版原生字幕面板走的是这个 InnerTube 接口，不是 timedtext。 */
export const GET_TRANSCRIPT_PATH = '/youtubei/v1/get_transcript';

export interface TimedTextOutcome {
  lines: TranscriptLine[];
  format: LineFormat;
  code?: ErrorCode;
  detail?: string;
}

export function isTimedTextUrl(url: string): boolean {
  return url.includes(TIMEDTEXT_PATH);
}

export function isGetTranscriptUrl(url: string): boolean {
  return url.includes(GET_TRANSCRIPT_PATH);
}

/** 从 timedtext URL 上取 v= 参数，用来判断这条响应属于哪个视频。 */
export function videoIdFromTimedTextUrl(url: string): string | null {
  const match = /[?&]v=([\w-]{6,})/u.exec(url);
  return match ? match[1] : null;
}

/**
 * 从 timedtext URL 取「这条响应是什么语言」。
 *
 * tlang 优先：带 tlang 时 `lang` 是**源**轨道语言，`tlang` 才是产出语言。
 * 之前取 lang 会把机器翻译的结果标成源语言，进而把中文内容按英文缓存。
 */
export function langFromTimedTextUrl(url: string): string | null {
  // 先单独找 tlang：正则的 | 按「最左匹配」而不是「选项顺序」，
  // 写成 (?:tlang|lang) 时 `?lang=en&tlang=zh-Hans` 仍会先命中 lang。
  const translated = /[?&]tlang=([\w-]+)/u.exec(url);
  if (translated) return translated[1];
  const plain = /[?&]lang=([\w-]+)/u.exec(url);
  return plain ? plain[1] : null;
}

export function buildTimedTextUrl(
  baseUrl: string,
  fmt: 'json3' | 'srv1',
  tlang?: string | null,
): string {
  const url = new URL(baseUrl, 'https://www.youtube.com');
  url.searchParams.set('fmt', fmt);
  // tlang 让 YouTube 把这条轨道机器翻译成目标语言；不传则原样返回
  if (tlang) url.searchParams.set('tlang', tlang);
  return url.toString();
}

/** HTTP 状态 → 分类错误码。403 在加了 POT 之后基本等价于「被拦截」。 */
export function classifyStatus(status: number): ErrorCode {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401 || status === 403) return 'POT_ENFORCED';
  if (status === 404) return 'NO_CAPTION_TRACK';
  if (status >= 500) return 'NETWORK_ERROR';
  return 'UNKNOWN';
}

export function trackLabel(track: CaptionTrack): string {
  return track.name || track.languageCode || 'unknown';
}

/**
 * 主动请求 timedtext。空 body 是 POT 生效后的典型表现（HTTP 200 + 0 字节），
 * 必须与「真的没有字幕」区分开。
 */
export async function fetchTimedText(
  fetchFn: typeof fetch,
  baseUrl: string,
  fmt: 'json3' | 'srv1',
  signal: AbortSignal,
  tlang?: string | null,
): Promise<TimedTextOutcome> {
  const format: LineFormat = fmt === 'json3' ? 'json3' : 'srv';
  let response: Response;
  try {
    response = await fetchFn(buildTimedTextUrl(baseUrl, fmt, tlang), {
      credentials: 'include',
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return { lines: [], format, code: 'NETWORK_ERROR', detail: String(error) };
  }

  if (!response.ok) {
    return {
      lines: [],
      format,
      code: classifyStatus(response.status),
      detail: `http ${response.status}`,
    };
  }

  const raw = await response.text();
  if (!raw.trim()) {
    return { lines: [], format, code: 'EMPTY_200', detail: 'empty body' };
  }
  // 200 + 拦截页：必须当成失败，否则那段提示会被解析成「一条字幕」
  if (isBlockedPayload(raw)) {
    return { lines: [], format, code: 'RATE_LIMITED', detail: 'youtube blocked the request (unusual traffic)' };
  }

  try {
    const lines = fmt === 'json3' ? parseJson3(raw) : parseSrv(raw);
    return { lines, format };
  } catch (error) {
    return { lines: [], format, code: 'UNKNOWN', detail: String(error) };
  }
}
