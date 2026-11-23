import { formatTimestamp } from '../core/format/export';
import type { StoryboardFrame } from '../core/storyboard';
import type { TranscriptLine } from '../core/types';
import { h } from './dom';
import { renderHighlighted } from './search';

/**
 * 一行字幕。
 *
 * 节奏靠三层比例区分，不靠固定像素：
 *   行距      由 CSS 变量派生（--ytt-lh，默认正文 ×1.65）
 *   行内边距  2px —— 字幕一行一句，行距本身就够，再塞 6px 会散成表格
 *   段间      由 .ytt-row-para 追加 ≈0.35 行高，只有真正的段落起点才加
 *
 * 之前每行恒定 py-1.5（6px），所有人都按 34px 排，既没有段的概念也太松：
 * 现在「连续的行」紧、「换段的行」松，才是文章该有的疏密。
 */
const ROW_BASE =
  'group absolute left-0 right-0 top-0 flex w-full items-start gap-3 rounded-lg px-4 py-0.5 text-left transition-colors duration-150';
const ROW_ACTIVE = 'bg-[var(--ytt-accent-soft)]';
const ROW_IDLE = 'hover:bg-[var(--ytt-hover)]';
/**
 * 竖条跟着内边距走，才能只覆盖正文那一段高度。
 * `left-1` + 行内 `px-4`：正文离面板左边 16px（和工具栏对齐），
 * 竖条占 4-7px，所以条与字的间距是 9px —— 原来是 17px，看着像两列。
 */
const BAR_BASE = 'absolute bottom-[2px] left-1 top-[2px] w-[3px] rounded-full transition-colors';
const BAR_ON = 'bg-[var(--ytt-accent)]';
const BAR_OFF = 'bg-transparent';
/**
 * 时间戳**内联在正文开头**：`(0:00) 正文…`
 *
 * 和正文同一条文字流、不带底色、整体不折行；行高由 .ytt-line-time 与正文
 * 共用同一个 `--ytt-lh` —— 两边差一像素基线就会歪。
 */
const TIME_BASE = 'ytt-line-time mr-[0.6em] whitespace-nowrap transition-colors';
const TIME_ON = 'text-[var(--ytt-text-dim)]';
const TIME_OFF = 'text-[var(--ytt-text-mute)] group-hover:text-[var(--ytt-text-dim)]';
const TEXT_BASE = 'min-w-0 flex-1 ytt-line-body';
/**
 * 正文按语言分两套排法（字号/字族/行距都在 styles.css 的 .ytt-line-* 里）：
 *
 *   中文行 → 苹方 + 0.04em 字距 + 中文行距（1.65 倍）
 *   英文行 → **同样字号**、不拉字距、行距收紧 12%（拉丁 x 高度小，1.65 倍太散）
 *
 * 两者字号相同，靠「字距 + 行距 + 字面」区分，混排时不会一眼看出字号跳变。
 *
 * 激活行**不改字重**：500 在只有 400/700 的中文字体上会被合成或回退，
 * 字宽一变就折行、行高一变虚拟列表的偏移就全错。强调只交给颜色和左侧竖条。
 */
const TEXT_CN = 'ytt-line-cn';
const TEXT_EN = 'ytt-line-en';
/**
 * 正文颜色走 `--ytt-transcript` / `--ytt-transcript-idle`（styles.css 里按主题配）：
 *   深色主题 → 激活亮、非激活灰（保持原样）
 *   浅色主题 → 两者都是 #0f0f0f（白底上灰字发飘，纸面正文就该是纯黑）
 */
const TEXT_ON = 'text-[var(--ytt-transcript)]';
const TEXT_OFF = 'text-[var(--ytt-transcript-idle)] group-hover:text-[var(--ytt-transcript)]';

/** 汉字 / 假名 / 全角标点：命中即按「中文行」排版 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60]/;

function fontClassFor(text: string): string {
  return CJK_RE.test(text) ? TEXT_CN : TEXT_EN;
}

/** 有非折叠选区就不跳转 —— 否则想拖选一句话会被当成点击 seek */
function hasTextSelection(): boolean {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return false;
  try {
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
  } catch {
    return false;
  }
}

export interface RowOptions {
  line: TranscriptLine;
  original: number;
  active: boolean;
  showTimestamps: boolean;
  needle: string;
  /** 章节视图下该时间点的截图；取不到就不传，行布局保持不变 */
  thumb?: StoryboardFrame | null;
  /** 这一行是段落起点：多给一点上方留白，读起来才有「段」的概念 */
  paraStart?: boolean;
  /** 单位：秒。TranscriptLine.start 是毫秒，转换在调用点完成。 */
  onSeek: (seconds: number) => void;
}

/** 一行字幕：左侧播放条 + 可选时间戳 + 带高亮的正文。 */
export function createRow(options: RowOptions): HTMLElement {
  const { line, original, active, showTimestamps, needle, paraStart } = options;

  const row = h('button', {
    class:
      `${ROW_BASE} ${active ? ROW_ACTIVE : ROW_IDLE} ${line.start >= 0 ? 'cursor-pointer' : 'cursor-default'}` +
      // 段首才加额外留白：连续的行贴紧，换段才松
      (paraStart ? ' ytt-row-para' : ''),
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
        class: 'ytt-thumb shrink-0 overflow-hidden rounded bg-[var(--ytt-hover)]',
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

  // 字体跟随这一行自己的文字，不看轨道语言：混排字幕里中文行等宽、英文行小一号
  const fontClass = fontClassFor(line.text);
  row.dataset.font = fontClass === TEXT_EN ? 'en' : 'cn';

  const text = h('span', { class: `${TEXT_BASE} ${fontClass} ${active ? TEXT_ON : TEXT_OFF}` });
  text.dataset.role = 'text';

  // 时间戳内联在正文最前面（同一段文字流）：`(0:00) 正文…`
  if (showTimestamps) {
    const time = h('span', {
      class: `${TIME_BASE} ${active ? TIME_ON : TIME_OFF}`,
      text: `(${formatTimestamp(line.start)})`,
    });
    time.dataset.role = 'time';
    text.appendChild(time);
  }

  text.append(renderHighlighted(line.text, needle));
  row.appendChild(text);

  row.addEventListener('click', () => {
    // 正在拖选正文时不跳转：阅读场景里「选一句话复制」比「点一下跳过去」更常见
    if (hasTextSelection()) return;
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
  if (text) {
    // 字体档位建行时定好存在 dataset，这里只能复用 —— 重建时别把等宽/12px 弄丢
    const fontClass = row.dataset.font === 'en' ? TEXT_EN : TEXT_CN;
    text.className = `${TEXT_BASE} ${fontClass} ${active ? TEXT_ON : TEXT_OFF}`;
  }
}
