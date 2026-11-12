import { closeTranscriptPanel, countSegments, openTranscriptPanel, pickPanel } from './panel';

export interface PanelSession {
  openPanel(): Promise<Element | null>;
  closePanel(panel: unknown): void;
}

/**
 * 原生面板的「打开 → 抓取 → 收回」生命周期。
 *
 * 面板只是抓取载体：抓完必须收掉，否则页面上会同时挂着 YouTube 原生字幕和我们的面板。
 * 但如果面板是用户自己打开的就不要去关 —— 用 openedByUs 记住归属。
 */
export function createPanelSession(doc: Document, waitMs = 2500): PanelSession {
  let openedByUs = false;

  return {
    openPanel() {
      // 只有「已经含片段」的面板才算真的开着。空壳（只有标题、没有行）必须
      // 走 openTranscriptPanel 去点 Show transcript —— 之前这里只要有面板就短路，
      // 触发器永远不会被点，这就是「原版 Copy Transcript 能拿到、新版拿不到」的分歧点：
      // 原版流程直接调 openTranscriptPanel，没有这层短路。
      const existing = pickPanel(doc);
      if (existing && countSegments(existing) > 0) return Promise.resolve(existing);
      openedByUs = true;
      return openTranscriptPanel(doc, { waitMs });
    },
    closePanel(panel) {
      if (!openedByUs) return;
      openedByUs = false;
      closeTranscriptPanel(doc, (panel as Element | null) ?? pickPanel(doc));
    },
  };
}
