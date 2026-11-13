import type { TranscriptLine } from '../../types';

const VIDEO_ID_RE = /"?videoId"?\s*[:=]\s*"?([\w-]{11})/u;

/** base64 → binary string。浏览器用 atob，node（单测）用 Buffer，都没有就放弃。 */
function decodeBase64(input: string): string | null {
  const normalized = input.replace(/-/gu, '+').replace(/_/gu, '/');
  try {
    if (typeof atob === 'function') return atob(normalized);
    const buffer = (globalThis as { Buffer?: { from: (s: string, enc: string) => { toString: (enc: string) => string } } })
      .Buffer;
    if (buffer) return buffer.from(normalized, 'base64').toString('binary');
  } catch {
    /* 非法 base64，交给上层 */
  }
  return null;
}

/**
 * get_transcript 的 `params` 是 base64(protobuf)，videoId 在第 1 个字段：
 * 字节序列 `0x0a 0x0b <11 字节 id>`。这是**请求里唯一可信的归属信息**。
 */
const PARAM_VIDEO_ID_RE = /\u000a\u000b([A-Za-z0-9_-]{11})/u;

/**
 * 从 get_transcript 的**请求体**里取 videoId。
 *
 * 这个接口的 URL 上只有 prettyPrint，真实视频 id 藏在 POST body 里：
 *  - 新版 body 里可能直接有 `videoId` 字段；
 *  - 更常见的是只有 `params`，必须 base64 解码后从 protobuf 里读。
 *
 * 为什么非要读到它：读不到就只能退回「发请求那一刻的地址栏」，而 SPA 切页时
 * 地址栏先变、面板后变，旧面板迟到的请求会被错标成新视频 —— 于是新视频
 * 显示的正是上一个视频的字幕，而且 id 完全对得上，怎么查都查不出来。
 */
export function videoIdFromGetTranscriptBody(body: unknown): string | null {
  if (typeof body !== 'string') return null;

  const direct = VIDEO_ID_RE.exec(body);
  if (direct) return direct[1];

  const params = /"params"\s*:\s*"([^"]+)"/u.exec(body);
  if (!params) return null;

  const decoded = decodeBase64(params[1]);
  const match = decoded ? PARAM_VIDEO_ID_RE.exec(decoded) : null;
  return match ? match[1] : null;
}

function collectSnippet(snippet: unknown): string {
  if (!snippet || typeof snippet !== 'object') return '';
  const node = snippet as { simpleText?: unknown; runs?: unknown };
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (!Array.isArray(node.runs)) return '';
  return node.runs
    .map((run) => {
      if (!run || typeof run !== 'object') return '';
      const text = (run as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

/**
 * `youtubei/v1/get_transcript` 的响应 → 字幕行。
 *
 * 2026 版原生字幕面板走的是这个接口（不是 timedtext），返回的是结构化 JSON：
 * `transcriptSegmentRenderer { startMs, endMs, snippet.runs[] }`。
 * 它是唯一「既有结构化时间戳、又不吃 POT」的路径，所以值得单独解析。
 */
export function parseGetTranscript(raw: string): TranscriptLine[] {
  if (!raw.trim()) return [];

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }

  const lines: TranscriptLine[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const record = node as Record<string, unknown>;
    const segment = record.transcriptSegmentRenderer as Record<string, unknown> | undefined;
    if (segment) {
      const start = Number(segment.startMs);
      const end = Number(segment.endMs);
      const text = collectSnippet(segment.snippet).replace(/\s+/gu, ' ').trim();
      if (Number.isFinite(start) && text) {
        lines.push({
          start,
          dur: Number.isFinite(end) ? Math.max(0, end - start) : 0,
          text,
        });
      }
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') walk(value);
    }
  };

  walk(payload);
  return lines.sort((a, b) => a.start - b.start);
}
