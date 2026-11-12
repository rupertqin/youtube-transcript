import { formatTimestamp } from '../core/format/export';
import type { TranscriptLine } from '../core/types';
import { h } from './dom';
import { renderHighlighted } from './search';

const ROW_BASE =
  'group absolute left-0 top-0 flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors duration-150';
const ROW_ACTIVE = 'bg-[var(--ytt-accent-soft)]';
const ROW_IDLE = 'hover:bg-[var(--ytt-hover)]';
const BAR_BASE = 'absolute bottom-1.5 left-1 top-1.5 w-[3px] rounded-full transition-colors';
const BAR_ON = 'bg-[var(--ytt-accent)]';
const BAR_OFF = 'bg-transparent';
const TIME_BASE = 'mt-[2px] w-[38px] shrink-0 text-right text-[11px] tabular-nums transition-colors';
const TIME_ON = 'text-[var(--ytt-accent)]';
const TIME_OFF = 'text-[var(--ytt-text-mute)] group-hover:text-[var(--ytt-text-dim)]';
const TEXT_BASE = 'min-w-0 flex-1 text-[12.5px] leading-[1.6]';
const TEXT_ON = 'font-medium text-[var(--ytt-text)]';
const TEXT_OFF = 'text-[var(--ytt-text-dim)] group-hover:text-[var(--ytt-text)]';

export interface RowOptions {
  line: TranscriptLine;
  original: number;
  active: boolean;
  showTimestamps: boolean;
  needle: string;
  onSeek: (seconds: number) => void;
}

/** 一行字幕：左侧播放条 + 可选时间戳 + 带高亮的正文。 */
export function createRow(options: RowOptions): HTMLElement {
  const { line, original, active, showTimestamps, needle } = options;

  const row = h('button', {
    class: `${ROW_BASE} ${active ? ROW_ACTIVE : ROW_IDLE} ${line.start >= 0 ? 'cursor-pointer' : 'cursor-default'}`,
    attrs: { type: 'button' },
  });
  row.dataset.original = String(original);
  row.dataset.hasTime = showTimestamps ? '1' : '0';

  row.appendChild(h('span', { class: `${BAR_BASE} ${active ? BAR_ON : BAR_OFF}` }));

  if (showTimestamps) {
    row.appendChild(
      h('span', { class: `${TIME_BASE} ${active ? TIME_ON : TIME_OFF}`, text: formatTimestamp(line.start) }),
    );
  }

  const text = h('span', { class: `${TEXT_BASE} ${active ? TEXT_ON : TEXT_OFF}` });
  text.append(renderHighlighted(line.text, needle));
  row.appendChild(text);

  row.addEventListener('click', () => {
    if (line.start >= 0) options.onSeek(line.start);
  });

  return row;
}

/** 播放位置变化时只改 class，不重建行。 */
export function applyRowState(row: HTMLElement, active: boolean, showTimestamps: boolean): void {
  row.classList.toggle(ROW_ACTIVE, active);
  row.classList.toggle(ROW_IDLE, !active);

  const [bar, second, third] = Array.from(row.children) as HTMLElement[];
  if (bar) bar.className = `${BAR_BASE} ${active ? BAR_ON : BAR_OFF}`;

  if (showTimestamps) {
    if (second) second.className = `${TIME_BASE} ${active ? TIME_ON : TIME_OFF}`;
    if (third) third.className = `${TEXT_BASE} ${active ? TEXT_ON : TEXT_OFF}`;
  } else if (second) {
    second.className = `${TEXT_BASE} ${active ? TEXT_ON : TEXT_OFF}`;
  }
}
