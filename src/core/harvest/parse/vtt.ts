import type { TranscriptLine } from '../../types';
import { collapseWhitespace, decodeEntities, dropEmpty, stripTags } from './text';

const TIME_RE = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;

function parseTime(input: string): number | null {
  const match = TIME_RE.exec(input.trim());
  if (!match) return null;
  const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  const millis = Number.parseInt(match[4].padEnd(3, '0'), 10);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

/** WEBVTT：cue 之间用空行分隔，timing 行形如 00:00:01.000 --> 00:00:03.000 */
export function parseVtt(raw: string): TranscriptLine[] {
  const blocks = raw.replace(/\r\n?/gu, '\n').split(/\n{2,}/u);
  const lines: TranscriptLine[] = [];

  for (const block of blocks) {
    const rows = block.split('\n').filter((row) => row.trim().length > 0);
    if (rows.length === 0) continue;
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/iu.test(rows[0])) continue;

    const timingIndex = rows.findIndex((row) => row.includes('-->'));
    if (timingIndex === -1) continue;

    const [rawStart, rawEnd] = rows[timingIndex].split('-->');
    const start = parseTime((rawStart ?? '').trim());
    const end = parseTime((rawEnd ?? '').trim().split(/\s+/u)[0] ?? '');
    if (start === null || end === null) continue;

    const text = collapseWhitespace(
      decodeEntities(stripTags(rows.slice(timingIndex + 1).join(' '))),
    );
    if (!text) continue;
    lines.push({ start, dur: Math.max(0, end - start), text });
  }

  return dropEmpty(lines).sort((a, b) => a.start - b.start);
}
