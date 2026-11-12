/**
 * verbatim-runtime.js 暴露出来的原版 v1.9 内部函数（见 scripts/sync-legacy.mjs）。
 * 注意：user-script.js 的 SEL.panels 已扩展 2026 选择器，签名不变、别按旧三条理解。
 */
export interface LegacyV19 {
  SEL: {
    mastheadEnd: string;
    panels: string;
    list: string;
    segOld: string;
    segNew: string;
    stamp: string;
    text: string;
  };
  sleep(ms: number): Promise<void>;
  normalize(s: string | null | undefined): string;
  waitForElement(selector: string, timeout?: number): Promise<Element>;
  isVisible(el: Element | null | undefined): boolean;
  countSegments(root: ParentNode): number;
  pickPanel(): Element | null;
  waitForSegments(panel: ParentNode, timeout?: number): Promise<boolean>;
  openTranscriptPanel(): Promise<Element | null>;
  segmentSelectorFor(list: ParentNode): string;
  collectFromList(list: ParentNode): { lines: string[]; showTimestamps: boolean; segCount: number };
  collapseDuplicates(lines: string[], aggressive: boolean): string[];
  extractTranscript(panel: Element): Promise<{ text: string; showTimestamps: boolean }>;
  extractFallback(panel: Element): { text: string };
  normalizeLines(s: string): string;
  copyToClipboard(text: string): Promise<boolean>;
  buildButton(): HTMLElement;
  addCopyButton(): Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __yttLegacyV19: LegacyV19 | undefined;
}
