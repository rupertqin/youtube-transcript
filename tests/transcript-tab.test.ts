import { describe, expect, it, vi } from 'vitest';
import { extractTranscriptLegacy, getLegacyDiagnostic } from '../src/core/dom/legacy';
import type { LegacyV19 } from '../src/legacy/contract';

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

const SUBTITLES = [
  '0:02 Welcome everyone to Rails World',
  '0:05 Let me start with a quick story',
  '0:09 Today we are going to talk about',
  '0:14 And I want to show you something',
].join('\n');

const TAB_SELECTOR = 'button,[role="tab"],yt-chip-cloud-chip-renderer,yt-tab-shape';

interface TabFixture {
  doc: Document;
  chipClick: ReturnType<typeof vi.fn>;
  showClick: ReturnType<typeof vi.fn>;
}

/** 面板已 EXPANDED 但停在 Chapters：只有 Transcript 标签能让字幕渲染出来。 */
function tabFixture(options: { withTab?: boolean; expanded?: boolean } = {}): TabFixture {
  const body = {
    innerText: 'In this video ChaptersTranscript Search transcriptChapter 1 3:32',
    textContent: '',
  } as HTMLElement;

  const chipClick = vi.fn(() => {
    body.innerText = SUBTITLES;
  });
  const showClick = vi.fn();

  const chip = {
    id: '',
    tagName: 'BUTTON',
    textContent: 'Transcript',
    children: [],
    getAttribute: (name: string) => (name === 'class' ? 'ytChipShapeButtonReset' : ''),
    getClientRects: () => [{ width: 1 }],
    click: chipClick,
  } as unknown as HTMLElement;

  const showButton = {
    id: '',
    tagName: 'BUTTON',
    textContent: 'Show transcript',
    children: [],
    getAttribute: () => '',
    getClientRects: () => [{ width: 1 }],
    click: showClick,
  } as unknown as HTMLElement;

  const expandedPanel = {
    getAttribute: (name: string) =>
      name === 'visibility' ? 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' : '',
  } as unknown as Element;

  const doc = {
    body,
    querySelector: () => null,
    querySelectorAll: (selector: string) => {
      if (selector === TAB_SELECTOR && options.withTab !== false) return [chip, showButton];
      if (selector === '[visibility]' && options.expanded) return [expandedPanel];
      return [];
    },
  } as unknown as Document;

  return { doc, chipClick, showClick };
}

function stubV19(openPanel: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('__yttLegacyV19', {
    extractFallback: originalFallback,
    openTranscriptPanel: openPanel,
    extractTranscript: async () => ({ text: '', showTimestamps: false }),
  } as unknown as LegacyV19);
}

describe('面板停在 Chapters 标签页时切到 Transcript', () => {
  it('精确点击 Transcript 标签，等渲染后读出字幕，且不碰 Show transcript', async () => {
    const openPanel = vi.fn(async () => null);
    stubV19(openPanel);
    const { doc, chipClick, showClick } = tabFixture();

    const result = await extractTranscriptLegacy(doc);

    expect(chipClick).toHaveBeenCalledTimes(1);
    expect(showClick).not.toHaveBeenCalled();
    expect(openPanel).not.toHaveBeenCalled();
    expect(result.lines).toHaveLength(4);
    expect(result.lines[0]).toEqual({ start: 2000, dur: 0, text: 'Welcome everyone to Rails World' });
    expect(getLegacyDiagnostic()).toContain('已点击 Transcript 标签');
  });

  it(
    '没有 Transcript 标签时，不误点 Show transcript，仍让修好的原版路径兜底',
    async () => {
      const openPanel = vi.fn(async () => null);
      stubV19(openPanel);
      const { doc, showClick } = tabFixture({ withTab: false, expanded: true });

      const result = await extractTranscriptLegacy(doc);

      expect(showClick).not.toHaveBeenCalled();
      expect(openPanel).toHaveBeenCalledTimes(1);
      expect(result.lines).toEqual([]);
      expect(getLegacyDiagnostic()).toContain('走原版 openTranscriptPanel');
    },
    10_000,
  );
});
