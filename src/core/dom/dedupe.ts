import type { TranscriptLine } from '../types';

/**
 * 重复内容兜底（结构修复失效时的第二道保险）。
 * - 连续重复折叠：仅在检测到多列表 / 片段数异常时启用
 * - 整段重复：前后两半完全相同则保留一半
 */
export function collapseDuplicates(lines: TranscriptLine[], aggressive: boolean): TranscriptLine[] {
  if (lines.length < 2) return lines;

  let out = lines;
  if (aggressive) {
    out = [];
    for (const line of lines) {
      const prev = out[out.length - 1];
      if (!prev || prev.text !== line.text) out.push(line);
    }
  }

  if (out.length >= 4 && out.length % 2 === 0) {
    const half = out.length / 2;
    const head = out.slice(0, half).map((line) => line.text).join('\n');
    const tail = out.slice(half).map((line) => line.text).join('\n');
    if (head === tail) return out.slice(0, half);
  }

  return out;
}
