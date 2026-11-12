import type { TranscriptLine } from '../../types';
import { dropEmpty, joinSegments, toMs } from './text';

interface Json3Segment {
  utf8?: string;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Segment[];
  /** 自动生成轨道里的续行标记，本身没有时间 */
  aAppend?: number;
}

interface Json3Payload {
  events?: Json3Event[];
}

/**
 * json3 是 YouTube 默认的 timedtext 格式：
 * { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }
 */
export function parseJson3(raw: string | Json3Payload): TranscriptLine[] {
  const payload: Json3Payload =
    typeof raw === 'string' ? (JSON.parse(raw) as Json3Payload) : raw;
  const events = Array.isArray(payload.events) ? payload.events : [];

  const collected: TranscriptLine[] = [];
  for (const event of events) {
    if (!event || !Array.isArray(event.segs)) continue;
    const text = joinSegments(event.segs.map((seg) => seg?.utf8 ?? ''));
    if (!text.trim()) continue;
    collected.push({
      start: toMs(event.tStartMs, 'ms'),
      dur: toMs(event.dDurationMs, 'ms'),
      text,
    });
  }

  return dropEmpty(collected).sort((a, b) => a.start - b.start);
}
