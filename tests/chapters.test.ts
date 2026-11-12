import { beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotTranscriptText } from '../src/core/dom/legacy';
import { looksLikeTranscript } from '../src/core/lines';
import type { LegacyV19 } from '../src/legacy/contract';
import type { TranscriptLine } from '../src/core/types';

/** 原版 extractFallback 的等价切分，作为 __yttLegacyV19 的测试替身。 */
function originalFallback(panel: Element): { text: string } {
  const raw = ((panel as HTMLElement | null)?.innerText || '')
    .split('\n')
    .map((row) => row.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join('\n');
  if (!raw) return { text: '' };
  const parts = raw.split(/\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*/u);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const time = parts[i];
    const body = (parts[i + 1] ?? '').replace(/\s+/gu, ' ').trim();
    if (time && body) out.push(`${time} ${body}`);
  }
  return { text: out.length ? out.join('\n') : raw };
}

function docWithVisibleText(innerText: string): Document {
  return {
    body: { innerText, textContent: innerText },
    querySelector: () => null,
    querySelectorAll: () => [],
  } as unknown as Document;
}

const line = (start: number, text: string): TranscriptLine => ({ start, dur: 0, text });

beforeEach(() => {
  vi.stubGlobal('__yttLegacyV19', {
    extractFallback: originalFallback,
  } as unknown as LegacyV19);
});

describe('Chapters 时间点不是字幕', () => {
  it('截图里那种 22 行章节（带 JSON 残留 `] — …\\n[`）不产出结果', () => {
    const chapters = [
      "28:14 ] — Rethinking HEY's backend with agents\\n[",
      '33:04 ] — Where does this leave Ruby and Rails?\\n[',
      '34:23 ] — Agent evals with Evil Martians and the Rails Foundation\\n[',
      '36:28 ] — 150,000 lines of code in a month\\n[',
      '38:06 ] — English: the programming language DHH likes\\n[',
    ].join('\n');

    expect(snapshotTranscriptText(docWithVisibleText(chapters))).toBe('');
  });

  it('干净的章节标题也因相邻间隔几分钟而被挡掉', () => {
    const chapters = [
      '28:14 Rethinking HEY backend with agents',
      '33:04 Where does this leave Ruby and Rails',
      '34:23 Agent evals with Evil Martians',
      '36:28 150000 lines of code in a month',
      '38:06 English the programming language DHH likes',
    ].join('\n');

    expect(snapshotTranscriptText(docWithVisibleText(chapters))).toBe('');
  });

  it('真字幕（相邻只隔几秒）仍能读出', () => {
    const subtitles = [
      '0:02 Welcome everyone to Rails World',
      '0:05 Let me start with a quick story',
      '0:09 Today we are going to talk about',
      '0:14 And I want to show you something',
    ].join('\n');

    expect(snapshotTranscriptText(docWithVisibleText(subtitles)).split('\n')).toHaveLength(4);
  });

  it('缓存校验也拒收章节数组、接受真字幕', () => {
    const chapters = [1694000, 1984000, 2063000, 2188000].map((start) => line(start, 'chapter'));
    expect(looksLikeTranscript(chapters)).toBe(false);

    const subtitles = [2000, 5000, 9000, 14000].map((start) => line(start, 'spoken words'));
    expect(looksLikeTranscript(subtitles)).toBe(true);
  });
});
