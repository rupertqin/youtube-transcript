import type { TranscriptLine } from './types';

export function hasTimestamps(lines: TranscriptLine[]): boolean {
  return lines.some((line) => line.start >= 0);
}

/** 二分定位当前播放行：1000+ 行时不要每帧全表扫。 */
export function findActiveIndex(lines: TranscriptLine[], seconds: number): number {
  if (lines.length === 0) return -1;
  const ms = Math.max(0, seconds * 1000);
  let low = 0;
  let high = lines.length - 1;
  let best = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].start <= ms) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

export function totalDuration(lines: TranscriptLine[]): number {
  if (lines.length === 0) return 0;
  const last = lines[lines.length - 1];
  return Math.max(0, last.start + last.dur);
}
