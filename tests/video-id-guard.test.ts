import { describe, expect, it, vi } from 'vitest';
import { extractFromNativePanel, getDomDiagnostic } from '../src/core/dom/native-panel';
import { discardStaleTranscriptPanel } from '../src/core/dom/panel';
import { readPlayerVideoId, readStoryboardSpec } from '../src/core/harvest/player';

/**
 * SPA 切页时「面板显示上一个视频的字幕」的根因：
 * 地址栏已经换到新视频，播放器还停在旧视频上，此时读 DOM 拿到的仍是旧字幕。
 * 抓取层必须能认出这种错配并放弃。
 */

function makeDoc(options: { player?: string | null; flexy?: string | null }): Document {
  const player = options.player
    ? { getVideoData: () => ({ video_id: options.player }) }
    : null;
  const flexy = options.flexy
    ? { getAttribute: () => options.flexy }
    : null;

  const doc: Record<string, unknown> = {
    querySelector: (selector: string) => {
      if (selector === '#movie_player') return player;
      if (selector === 'ytd-watch-flexy') return flexy;
      return null;
    },
    // 面板层会穿透 shadow root 找元素：没有这个查询会直接抛错
    querySelectorAll: () => [],
    body: { innerText: '', textContent: '' },
  };

  // readPlayerVideoId 只需要 win.document，给个最小实现即可
  doc.defaultView = { document: doc };
  return doc as unknown as Document;
}

const winOf = (doc: Document): Window => ({ document: doc }) as unknown as Window;

describe('readPlayerVideoId', () => {
  it('优先取播放器实例上的 video_id', () => {
    expect(readPlayerVideoId(winOf(makeDoc({ player: 'AAAAAAAAAAA', flexy: 'BBBBBBBBBBB' }))))
      .toBe('AAAAAAAAAAA');
  });

  it('播放器没就绪时用 ytd-watch-flexy 属性', () => {
    expect(readPlayerVideoId(winOf(makeDoc({ flexy: 'BBBBBBBBBBB' })))).toBe('BBBBBBBBBBB');
  });

  it('两者都没有时返回 null', () => {
    expect(readPlayerVideoId(winOf(makeDoc({})))).toBeNull();
  });
});

describe('extractFromNativePanel 的视频归属校验', () => {
  it('播放器还在播别的视频时直接放弃，不读 DOM 快照', async () => {
    const doc = makeDoc({ player: 'AAAAAAAAAAA' });

    const result = await extractFromNativePanel(doc, { videoId: 'BBBBBBBBBBB' });

    expect(result.lines).toHaveLength(0);
    expect(result.showTimestamps).toBe(false);
    expect(getDomDiagnostic()).toContain('videoId mismatch');
    expect(getDomDiagnostic()).toContain('BBBBBBBBBBB');
    expect(getDomDiagnostic()).toContain('AAAAAAAAAAA');
  });

  it('没有传 videoId 时不做校验，保持旧行为', async () => {
    const doc = makeDoc({ player: 'AAAAAAAAAAA' });

    // 只要不因为归属问题提前返回即可：这里 DOM 是空的，结果自然为空
    const result = await extractFromNativePanel(doc);
    expect(getDomDiagnostic()).not.toContain('videoId mismatch');
    expect(result.lines).toHaveLength(0);
  });

  it('刚切页时不把「页面现有文字」当成预览，等完整结构化结果', async () => {
    const doc = makeDoc({ player: 'BBBBBBBBBBB' });

    // 即使归属已经对齐，切页后的第一批 DOM 也可能是旧行。
    // DOM 现在只做临时预览，不再靠点开面板重建 —— 完整字幕走 get_transcript。
    const result = await extractFromNativePanel(doc, { videoId: 'BBBBBBBBBBB', skipSnapshot: true });

    expect(result.lines).toHaveLength(0);
    expect(getDomDiagnostic()).toContain('跳过页面现有文字');
    expect(getDomDiagnostic()).not.toContain('videoId mismatch');
    expect(getDomDiagnostic()).not.toContain('打开原生面板');
  });
});

describe('readStoryboardSpec 的视频归属校验', () => {
  const makeWin = (declaredId: string | undefined) => {
    const response = {
      videoDetails: declaredId ? { videoId: declaredId } : undefined,
      storyboards: {
        playerStoryboardSpecRenderer: {
          spec: 'https://i.ytimg.com/sb/x/storyboard3_L$L/$N.jpg?sqp=1|48#27#100#10#10#0#default#sig',
        },
      },
    };
    return {
      document: {
        querySelector: (selector: string) =>
          selector === '#movie_player' ? { getPlayerResponse: () => response } : null,
      },
    } as unknown as Window;
  };

  it('响应属于别的视频时不取截图，避免新视频配旧画面', () => {
    expect(readStoryboardSpec(makeWin('AAAAAAAAAAA'), 'BBBBBBBBBBB')).toBeNull();
  });

  it('归属一致时正常返回 spec', () => {
    const spec = readStoryboardSpec(makeWin('BBBBBBBBBBB'), 'BBBBBBBBBBB');
    expect(spec).toContain('storyboard3_L$L');
  });
});

describe('discardStaleTranscriptPanel', () => {
  // node 环境没有 Element/getComputedStyle：panel.ts 会做 instanceof 与可见性判断，
  // 这里补最小的宿主实现，让判定逻辑能真正跑到。
  class FakeElement {
    innerText = '';
    textContent = '';
    tagName = 'YTD-ENGAGEMENT-PANEL-SECTION-LIST-RENDERER';
    closer: { click: () => void } | null = null;

    getClientRects() {
      return [{}];
    }

    querySelector(selector: string) {
      return selector.includes('visibility-button') ? this.closer : null;
    }

    querySelectorAll() {
      return [];
    }
  }

  function withBrowserStubs(run: () => void): void {
    const g = globalThis as unknown as Record<string, unknown>;
    const savedElement = g.Element;
    const savedStyle = g.getComputedStyle;
    class Base {
      innerText = '';
      textContent = '';
      tagName = '';
      getClientRects() {
        return [{}];
      }
      querySelector() {
        return null;
      }
      querySelectorAll() {
        return [];
      }
    }
    g.Element = Base;
    g.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });

    // FakeElement 要能通过 instanceof 检查，临时挂到同一个基类上
    Object.setPrototypeOf(FakeElement.prototype, Base.prototype);

    try {
      run();
    } finally {
      g.Element = savedElement;
      g.getComputedStyle = savedStyle;
    }
  }

  function makePanel(text: string) {
    const panel = new FakeElement();
    panel.innerText = text;
    const closer = { click: vi.fn() };
    panel.closer = closer;
    return { panel, closer };
  }

  function makeDoc(panels: unknown[]): Document {
    return {
      querySelectorAll: (selector: string) =>
        selector.includes('engagement-panel') ? panels : [],
      querySelector: () => null,
    } as unknown as Document;
  }

  it('切页时收掉带时间码的残留面板，强制它按新视频重建', () => {
    withBrowserStubs(() => {
      const { panel, closer } = makePanel('0:01 第一行\n0:05 第二行\n0:09 第三行\n0:13 第四行');
      expect(discardStaleTranscriptPanel(makeDoc([panel]))).toBe(true);
      expect(closer.click).toHaveBeenCalledTimes(1);
    });
  });

  it('不是字幕面板（没有时间码）时不动它', () => {
    withBrowserStubs(() => {
      const { panel, closer } = makePanel('评论区\n暂无评论');
      expect(discardStaleTranscriptPanel(makeDoc([panel]))).toBe(false);
      expect(closer.click).not.toHaveBeenCalled();
    });
  });
});
