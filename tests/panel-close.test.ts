import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeTranscriptPanelIfOurs,
  closeTranscriptPanelVerified,
  isTranscriptPanelExpanded,
  transcriptPanelOpenedByUs,
} from '../src/core/dom/panel';

/**
 * 「原生字幕显示了不会消失」的根因：关闭是同步点一下就返回，
 * 而 YouTube 的面板状态是异步更新的，点完立刻检查仍是 EXPANDED。
 * 这里验证「点 → 等 → 再看」的重试循环确实会收敛，且有次数上限。
 */

class FakePanel {
  visibility = 'EXPANDED';
  clicks = 0;
  readonly text = '0:01 第一行\n0:05 第二行\n0:09 第三行';
  innerText = this.text;
  textContent = this.text;
  tagName = 'YTD-ENGAGEMENT-PANEL-SECTION-LIST-RENDERER';

  constructor(private readonly clickToClose = 1) {}

  getAttribute(name: string): string | null {
    return name === 'visibility' ? this.visibility : null;
  }

  getClientRects(): unknown[] {
    return this.visibility === 'EXPANDED' ? [{}] : [];
  }

  querySelectorAll(): unknown[] {
    return [];
  }

  querySelector(selector: string): { click: () => void } | null {
    if (!selector.includes('visibility-button')) return null;
    return {
      click: () => {
        this.clicks += 1;
        if (this.clicks >= this.clickToClose) this.visibility = 'COLLAPSED';
      },
    };
  }
}

function makeDoc(panel: FakePanel | null, attrs: Record<string, string> = {}): Document {
  return {
    documentElement: {
      getAttribute: (name: string) => attrs[name] ?? null,
      setAttribute: (name: string, value: string) => {
        attrs[name] = value;
      },
      removeAttribute: (name: string) => {
        delete attrs[name];
      },
    },
    querySelectorAll: (selector: string) =>
      selector === '*' ? [] : selector.includes('engagement-panel') && panel ? [panel] : [],
    querySelector: () => null,
  } as unknown as Document;
}

let savedStyle: unknown;

beforeEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  savedStyle = g.getComputedStyle;
  g.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).getComputedStyle = savedStyle;
  vi.restoreAllMocks();
});

describe('isTranscriptPanelExpanded', () => {
  it('EXPANDED 视为展开，COLLAPSED 视为已收起', () => {
    const panel = new FakePanel();
    expect(isTranscriptPanelExpanded(makeDoc(panel))).toBe(true);
    panel.visibility = 'COLLAPSED';
    expect(isTranscriptPanelExpanded(makeDoc(panel))).toBe(false);
  });

  it('页面上没有字幕面板时返回 false，不抛错', () => {
    expect(isTranscriptPanelExpanded(makeDoc(null))).toBe(false);
  });
});

describe('closeTranscriptPanelVerified', () => {
  it('点一次就收起时立即返回成功', async () => {
    const panel = new FakePanel();
    const ok = await closeTranscriptPanelVerified(makeDoc(panel));

    expect(ok).toBe(true);
    expect(panel.clicks).toBe(1);
    expect(isTranscriptPanelExpanded(makeDoc(panel))).toBe(false);
  });

  it('第一次点击没生效时会重试，直到真的收起', async () => {
    const panel = new FakePanel(3);
    const ok = await closeTranscriptPanelVerified(makeDoc(panel));

    expect(ok).toBe(true);
    expect(panel.clicks).toBe(3);
  });

  it('始终关不掉时有次数上限，不会无限重试', async () => {
    const panel = new FakePanel(999);
    const ok = await closeTranscriptPanelVerified(makeDoc(panel));

    expect(ok).toBe(false);
    expect(panel.clicks).toBe(3);
  });

  it('没有面板可关时直接成功，且不抛错', async () => {
    await expect(closeTranscriptPanelVerified(makeDoc(null))).resolves.toBe(true);
  });
});

describe('closeTranscriptPanelIfOurs：只收自己点开的面板', () => {
  it('用户自己开的面板一次都不点（点了屏幕上就是「字幕框闪一下」）', async () => {
    const panel = new FakePanel();
    const ok = await closeTranscriptPanelIfOurs(makeDoc(panel));

    expect(ok).toBe(false);
    expect(panel.clicks).toBe(0);
    expect(panel.visibility).toBe('EXPANDED');
  });

  it('我们点开的面板照常收起，收完清掉标记', async () => {
    const panel = new FakePanel();
    const attrs: Record<string, string> = { 'data-ytt-panel-opened': '1' };
    const doc = makeDoc(panel, attrs);

    const ok = await closeTranscriptPanelIfOurs(doc);

    expect(ok).toBe(true);
    expect(panel.clicks).toBe(1);
    expect(transcriptPanelOpenedByUs(doc)).toBe(false);
  });
});
