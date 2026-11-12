import { closeTranscriptPanel, openTranscriptPanel, pickPanel } from './panel';

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
      const existing = pickPanel(doc);
      if (existing) return Promise.resolve(existing);
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
