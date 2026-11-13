import { formatTimestamp } from '../core/format/export';
import type { StoryboardFrame } from '../core/storyboard';
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
  /** 章节视图下该时间点的截图；取不到就不传，行布局保持不变 */
  thumb?: StoryboardFrame | null;
  /** 单位：秒。TranscriptLine.start 是毫秒，转换在调用点完成。 */
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

  const bar = h('span', { class: `${BAR_BASE} ${active ? BAR_ON : BAR_OFF}` });
  bar.dataset.role = 'bar';
  row.appendChild(bar);

  const thumb = options.thumb;
  if (thumb) {
    // 雪碧图裁切：整张图集按显示宽度缩放，再平移把目标帧露出来
    row.appendChild(
      h('span', {
        class: 'mt-[1px] shrink-0 overflow-hidden rounded-[3px] bg-[var(--ytt-hover)]',
        style: {
          width: `${thumb.width}px`,
          height: `${thumb.height}px`,
          'background-image': `url("${thumb.url}")`,
          'background-size': `${thumb.sheetWidth}px ${thumb.sheetHeight}px`,
          'background-position': `${thumb.offsetX}px ${thumb.offsetY}px`,
          'background-repeat': 'no-repeat',
        },
        attrs: { 'aria-hidden': 'true' },
      }),
    );
  }

  if (showTimestamps) {
    const time = h('span', {
      class: `${TIME_BASE} ${active ? TIME_ON : TIME_OFF}`,
      text: formatTimestamp(line.start),
    });
    time.dataset.role = 'time';
    row.appendChild(time);
  }

  const text = h('span', { class: `${TEXT_BASE} ${active ? TEXT_ON : TEXT_OFF}` });
  text.dataset.role = 'text';
  text.append(renderHighlighted(line.text, needle));
  row.appendChild(text);

  row.addEventListener('click', () => {
    // line.start 是毫秒；session.seek() 直接写 video.currentTime，单位是秒。
    // 之前传毫秒会让 1:05 跳到 65000 秒，且高亮行全错。
    if (line.start >= 0) options.onSeek(line.start / 1000);
  });

  return row;
}

/**
 * 播放位置变化时只改 class，不重建行。
 * 用 data-role 定位子元素 —— 章节行多一个缩略图，靠 children 下标会错位。
 */
export function applyRowState(row: HTMLElement, active: boolean, _showTimestamps: boolean): void {
  row.classList.toggle(ROW_ACTIVE, active);
  row.classList.toggle(ROW_IDLE, !active);

  const bar = row.querySelector<HTMLElement>('[data-role="bar"]');
  if (bar) bar.className = `${BAR_BASE} ${active ? BAR_ON : BAR_OFF}`;

  const time = row.querySelector<HTMLElement>('[data-role="time"]');
  if (time) time.className = `${TIME_BASE} ${active ? TIME_ON : TIME_OFF}`;

  const text = row.querySelector<HTMLElement>('[data-role="text"]');
  if (text) text.className = `${TEXT_BASE} ${active ? TEXT_ON : TEXT_OFF}`;
}
