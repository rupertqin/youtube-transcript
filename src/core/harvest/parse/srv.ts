import type { TranscriptLine } from '../../types';
import { collapseWhitespace, decodeEntities, dropEmpty, stripTags, toMs } from './text';

function readAttr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs);
  return match ? match[1] : undefined;
}

function parseContents(inner: string): string {
  return collapseWhitespace(decodeEntities(stripTags(inner)));
}

/**
 * srv1 / srv3 都是 XML：
 *  - srv1:  <transcript><text start="1.23" dur="4.5">...</text>
 *  - srv3:  <timedtext format="3"><body><p t="1230" d="4500"><s>..</s></p>
 * 用正则解析而非 DOMParser，保证 node 环境可单测。
 */
export function parseSrv(raw: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];

  const textTag = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match: RegExpExecArray | null;
  while ((match = textTag.exec(raw)) !== null) {
    const text = parseContents(match[2]);
    if (!text) continue;
    lines.push({
      start: toMs(readAttr(match[1], 'start'), 's'),
      dur: toMs(readAttr(match[1], 'dur'), 's'),
      text,
    });
  }

  if (lines.length === 0) {
    const pTag = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    while ((match = pTag.exec(raw)) !== null) {
      const text = parseContents(match[2]);
      if (!text) continue;
      lines.push({
        start: toMs(readAttr(match[1], 't'), 'ms'),
        dur: toMs(readAttr(match[1], 'd'), 'ms'),
        text,
      });
    }
  }

  return dropEmpty(lines).sort((a, b) => a.start - b.start);
}
