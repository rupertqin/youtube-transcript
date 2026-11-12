import type { TranscriptLine } from '../types';

const TIMECODE_RE = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/u;
/** 行首时间码：`17:14` / `1:02:03`，后面必须跟空白或行尾，避免把正文里的时间串当分割点。 */
const LEADING_TIMECODE_RE = /^(\d{1,2}:\d{2}(?::\d{2})?)(?:\s+(.*))?$/u;

/** "1:23" / "01:02:03" → 毫秒；不是时间戳就返回 null。 */
export function parseTimecode(raw: string): number | null {
  const match = TIMECODE_RE.exec(raw.trim());
  if (!match) return null;
  const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

/**
 * 把一段文本按「行首时间码」切成字幕行。
 *
 * 这是与 DOM 标签名无关的最后一层：2026 版 YouTube 把字幕面板换成了
 * `*-view-model` 系自定义元素，`#segment-text` / `ytd-transcript-segment-renderer`
 * 都可能不再存在，但面板的 innerText 永远是「时间码 + 正文」的形状。
 */
export function parseTimecodeRows(raw: string): TranscriptLine[] {
  const text = raw.replace(/\r/gu, '');
  if (!text.trim()) return [];

  const lines: TranscriptLine[] = [];
  let current: { start: number; parts: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    const body = current.parts.join(' ').replace(/\s+/gu, ' ').trim();
    if (body) lines.push({ start: current.start, dur: 0, text: body });
    current = null;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+/gu, ' ').trim();
    if (!line) continue;

    const match = LEADING_TIMECODE_RE.exec(line);
    const start = match ? parseTimecode(match[1]) : null;
    if (match && start !== null) {
      flush();
      current = { start, parts: match[2] ? [match[2]] : [] };
      continue;
    }
    // 时间码独占一行的布局：正文在后续行里
    if (current) current.parts.push(line);
  }
  flush();

  return lines;
}

/** 文本里有多少行以时间码开头，用来判断「这块 DOM 是不是字幕面板」。 */
export function countTimecodes(raw: string): number {
  let count = 0;
  for (const rawLine of raw.replace(/\r/gu, '').split('\n')) {
    if (LEADING_TIMECODE_RE.test(rawLine.trim())) count += 1;
  }
  return count;
}
