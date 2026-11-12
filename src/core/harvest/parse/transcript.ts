import type { TranscriptLine } from '../../types';

const VIDEO_ID_RE = /"?videoId"?\s*[:=]\s*"?([\w-]{11})/u;

/**
 * 从 get_transcript 的**请求体**里取 videoId。
 * 这个接口的 videoId 在 POST body 里，URL 上只有 prettyPrint，靠 URL 认不出来。
 */
export function videoIdFromGetTranscriptBody(body: unknown): string | null {
  if (typeof body !== 'string') return null;
  const match = VIDEO_ID_RE.exec(body);
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
