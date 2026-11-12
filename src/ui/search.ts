import type { TranscriptLine } from '../core/types';
import { h } from './dom';

export interface SearchIndex {
  /** 全小写文本，只算一次 */
  haystack: string[];
  matches: number[];
}

export function buildIndex(lines: TranscriptLine[], needle: string): SearchIndex {
  const haystack = lines.map((line) => line.text.toLowerCase());
  const query = needle.trim().toLowerCase();
  if (!query) return { haystack, matches: [] };

  const matches: number[] = [];
  for (let i = 0; i < haystack.length; i += 1) {
    if (haystack[i].includes(query)) matches.push(i);
  }
  return { haystack, matches };
}

/** 把文本拆成 text / mark 节点，避免任何 innerHTML。 */
export function renderHighlighted(text: string, needle: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const query = needle.trim().toLowerCase();
  if (!query) {
    fragment.append(document.createTextNode(text));
    return fragment;
  }

  const lower = text.toLowerCase();
  let cursor = 0;
  for (;;) {
    const at = lower.indexOf(query, cursor);
    if (at === -1) {
      if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
      return fragment;
    }
    if (at > cursor) fragment.append(document.createTextNode(text.slice(cursor, at)));
    fragment.append(
      h('mark', {
        class: 'rounded-[3px] bg-[var(--ytt-highlight)] px-[1px] text-[var(--ytt-text)]',
        text: text.slice(at, at + query.length),
      }),
    );
    cursor = at + query.length;
  }
}
