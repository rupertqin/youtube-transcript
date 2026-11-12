/**
 * YouTube 的 DOM 命名在 A/B 环境里并不统一，这里同时保留 old(#id) / new(.class) 两套写法。
 * 这些选择器是踩过坑的成果，改动前请先跑一遍 DOM 抓取。
 */
export interface SelectorSet {
  mastheadEnd: string;
  panels: string;
  list: string;
  segOld: string;
  segNew: string;
  stamp: string;
  text: string;
}

export const DEFAULT_SELECTORS: SelectorSet = {
  mastheadEnd: 'ytd-masthead #end',
  panels: [
    'ytd-transcript-search-panel-renderer',
    // engagement-panel-transcript / engagement-panel-searchable-transcript 都要命中
    'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]',
    '[role="dialog"] ytd-transcript-segment-list-renderer',
  ].join(','),
  list: 'ytd-transcript-segment-list-renderer',
  segOld: 'ytd-transcript-segment-renderer, .ytd-transcript-segment-renderer',
  segNew: 'yt-transcript-segment-renderer',
  stamp: '#segment-timestamp, .segment-timestamp',
  text: '#segment-text, .segment-text',
};

const KEYS = Object.keys(DEFAULT_SELECTORS) as (keyof SelectorSet)[];

let current: SelectorSet = { ...DEFAULT_SELECTORS };

export function getSelectors(): SelectorSet {
  return current;
}

/**
 * 可选的远程 JSON 覆盖（默认关闭）。只接受已知字段的字符串值，
 * 避免任意数据污染出选择器注入。
 */
export function applySelectorOverrides(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const accepted: string[] = [];
  const next: SelectorSet = { ...current };

  for (const key of KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 400) continue;
    next[key] = trimmed;
    accepted.push(key);
  }

  current = next;
  return accepted;
}

export function resetSelectors(): void {
  current = { ...DEFAULT_SELECTORS };
}
