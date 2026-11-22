import { formatTimestamp } from '../core/format/export';
import type { StoryboardFrame } from '../core/storyboard';
import type { TranscriptLine } from '../core/types';
import { h } from './dom';
import { renderHighlighted } from './search';

/**
 * 一行字幕。
 *
 * 学原版的留白：左右 20px、上下 10/12px，块与块之间因此有约 22px 的空隙；
 * 时间戳**单独占一行**（原版就是时间在上、正文在下的两行结构），
 * 正文行高 24px。之前时间戳内联在正文首行、行距也小，读起来像表格。
 */
const ROW_BASE =
  'group absolute left-1 right-1 top-0 flex items-start gap-3 rounded-lg px-5 pb-3 pt-2.5 text-left transition-colors duration-150';
const ROW_ACTIVE = 'bg-[var(--ytt-accent-soft)]';
const ROW_IDLE = 'hover:bg-[var(--ytt-hover)]';
const BAR_BASE = 'absolute bottom-3 left-0 top-3 w-[3px] rounded-full transition-colors';
const BAR_ON = 'bg-[var(--ytt-accent)]';
const BAR_OFF = 'bg-transparent';
/**
 * 时间戳在原版里是**正文上方独立的一行**（不是左侧列，也不是首行内联）：
 * 12px 灰色、行高 16px、与正文之间留 6px。这样正文可以占满整个宽度，
 * 长句不会被时间戳挤成窄栏。
 */
const TIME_BASE =
  'mb-1.5 block w-fit rounded-[4px] bg-[var(--ytt-time-bg)] px-1.5 py-[1px] text-[12px] leading-[16px] tabular-nums transition-colors';
const TIME_ON = 'text-[var(--ytt-text-dim)]';
const TIME_OFF = 'text-[var(--ytt-text-mute)] group-hover:text-[var(--ytt-text-dim)]';
/** 正文 14px / 20px：与主流视频站的字幕行高一致 */
const TEXT_BASE = 'min-w-0 flex-1 text-[14px] leading-[20px]';
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
        class: 'mt-[3px] shrink-0 overflow-hidden rounded bg-[var(--ytt-hover)]',
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

  const text = h('span', { class: `${TEXT_BASE} ${active ? TEXT_ON : TEXT_OFF}` });
  text.dataset.role = 'text';

  // 时间戳放进正文里（同一段文字流），换行时与文字一起折行
  if (showTimestamps) {
    const time = h('span', {
      class: `${TIME_BASE} ${active ? TIME_ON : TIME_OFF}`,
      text: formatTimestamp(line.start),
    });
    time.dataset.role = 'time';
    text.appendChild(time);
  }

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
