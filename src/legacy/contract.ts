import type { TranscriptLine } from '../core/types';

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

  /* ---- 共享层：两个入口调用同一份实现，保证复制结果一致 ---- */
  formatStamp(ms: number): string;
  stripA11yDuration(text: string, expectedMs?: number): string;
  textToRows(text: string): TranscriptLine[];
  parseChapters(text: string): TranscriptLine[];
  readChapterRows(doc: Document): TranscriptLine[];
  formatCopyText(rows: TranscriptLine[], options: CopyTextOptions): string;
  sharedPrefs(): SharedPrefs;
  setSharedPrefs(patch: Partial<SharedPrefs>): SharedPrefs;
}

/** 复制偏好：新版 UI 写 globalThis.__yttSharedPrefs，原版按钮读同一份。 */
export interface SharedPrefs {
  timestamps: boolean;
  view: 'lines' | 'chapters';
}

export interface CopyTextOptions extends Partial<SharedPrefs> {
  chapters?: TranscriptLine[];
}

declare global {
  // eslint-disable-next-line no-var
  var __yttLegacyV19: LegacyV19 | undefined;
  // eslint-disable-next-line no-var
  var __yttSharedPrefs: SharedPrefs | undefined;
  // eslint-disable-next-line no-var
  var __yttSetSharedPrefs: ((patch: Partial<SharedPrefs>) => void) | undefined;
}
