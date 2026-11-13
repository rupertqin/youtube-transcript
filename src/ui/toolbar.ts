import type { ContentView, ExportFormat } from '../core/types';
import { h, setText, show } from './dom';
import { icon } from './icons';

const ICON_BTN =
  'inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--ytt-text-dim)] transition ' +
  'hover:bg-[var(--ytt-hover)] hover:text-[var(--ytt-text)] active:scale-95 ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

const EXPORTS: { format: ExportFormat; label: string; hint: string }[] = [
  { format: 'txt', label: '纯文本', hint: '.txt' },
  { format: 'md', label: 'Markdown', hint: '.md' },
  { format: 'srt', label: '字幕文件', hint: '.srt' },
  { format: 'json', label: '结构化', hint: '.json' },
];

export interface ToolbarView {
  matchCount: number;
  cursor: number;
  showTimestamps: boolean;
  timestampsAvailable: boolean;
  /** 当前展示/复制的是字幕还是章节 */
  view: ContentView;
  chaptersAvailable: boolean;
  copied: boolean;
  disabled: boolean;
}

export interface ToolbarOptions {
  onQueryChange: (value: string) => void;
  onJump: (direction: 1 | -1) => void;
  onToggleTimestamps: () => void;
  onToggleView: () => void;
  onCopy: () => void;
  onExport: (format: ExportFormat) => void;
}

export interface ToolbarHandle {
  element: HTMLElement;
  update(view: ToolbarView): void;
  setQuery(value: string): void;
  focusSearch(): void;
  closeMenu(): void;
  destroy(): void;
}

export function createToolbar(options: ToolbarOptions): ToolbarHandle {
  const searchInput = h('input', {
    class:
      'h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--ytt-text)] placeholder:text-[var(--ytt-text-mute)]',
    attrs: {
      type: 'text',
      placeholder: '搜索字幕…',
      'aria-label': '搜索字幕',
      spellcheck: 'false',
      autocomplete: 'off',
    },
  });

  const searchGlyph = icon('search', 13);
  searchGlyph.style.color = 'var(--ytt-text-mute)';

  const kbdHint = h('kbd', {
    class: 'shrink-0 rounded border border-[var(--ytt-border)] px-1 text-[10px] text-[var(--ytt-text-mute)]',
    text: '⌘K',
  });

  const clearBtn = h(
    'button',
    {
      class: 'shrink-0 text-[var(--ytt-text-mute)] transition hover:text-[var(--ytt-text)]',
      attrs: { type: 'button', 'aria-label': '清空搜索' },
    },
    [icon('close', 12)],
  );
  show(clearBtn, false);

  const searchWrap = h(
    'div',
    {
      class:
        'flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-transparent bg-[var(--ytt-surface)] px-2 transition focus-within:border-[var(--ytt-border-strong)] focus-within:bg-[var(--ytt-bg-elev)]',
    },
    [searchGlyph, searchInput, kbdHint, clearBtn],
  );

  const countEl = h('span', { class: 'px-1 text-[11px] tabular-nums text-[var(--ytt-text-mute)]' });
  const navWrap = h('div', { class: 'flex shrink-0 items-center gap-0.5 tabular-nums' }, [
    countEl,
    h(
      'button',
      { class: ICON_BTN, attrs: { type: 'button', 'aria-label': '上一个匹配' }, on: { click: () => options.onJump(-1) } },
      [icon('chevronUp')],
    ),
    h(
      'button',
      { class: ICON_BTN, attrs: { type: 'button', 'aria-label': '下一个匹配' }, on: { click: () => options.onJump(1) } },
      [icon('chevronDown')],
    ),
  ]);
  show(navWrap, false);

  const tsBtn = h(
    'button',
    {
      class: ICON_BTN,
      attrs: { type: 'button', 'aria-label': '切换时间戳' },
      on: { click: () => options.onToggleTimestamps() },
    },
    [icon('clock')],
  );

  // 字幕 / 章节 视图切换：两个入口共用同一份 prefs，切换后原版按钮复制的内容也跟着变
  const viewLabel = h('span', { text: '字幕' });
  const viewBtn = h(
    'button',
    {
      class:
        'inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-[var(--ytt-border)] px-2 text-[11px] font-medium text-[var(--ytt-text-dim)] transition hover:bg-[var(--ytt-hover)] hover:text-[var(--ytt-text)] disabled:cursor-not-allowed disabled:opacity-40',
      attrs: { type: 'button', 'aria-label': '切换字幕/章节' },
      on: { click: () => options.onToggleView() },
    },
    [icon('list', 12), viewLabel],
  );

  const copyBtn = h(
    'button',
    {
      class: ICON_BTN,
      attrs: { type: 'button', 'aria-label': '复制全部', title: '复制全部' },
      on: { click: () => options.onCopy() },
    },
    [icon('copy')],
  );

  const exportMenu = h('div', {
    class:
      'absolute right-0 top-8 z-30 hidden w-[152px] overflow-hidden rounded-lg border border-[var(--ytt-border)] bg-[var(--ytt-bg-elev)] py-1 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.65)]',
  });

  for (const item of EXPORTS) {
    exportMenu.appendChild(
      h(
        'button',
        {
          class:
            'flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] text-[var(--ytt-text-dim)] transition hover:bg-[var(--ytt-hover)] hover:text-[var(--ytt-text)]',
          attrs: { type: 'button' },
          on: {
            click: () => {
              setMenuOpen(false);
              options.onExport(item.format);
            },
          },
        },
        [
          h('span', { text: item.label }),
          h('span', { class: 'text-[10px] text-[var(--ytt-text-mute)]', text: item.hint }),
        ],
      ),
    );
  }

  const exportBtn = h(
    'button',
    {
      class: ICON_BTN,
      attrs: { type: 'button', 'aria-label': '导出', title: '导出' },
    },
    [icon('download')],
  );

  const exportWrap = h('div', { class: 'relative' }, [exportBtn, exportMenu]);

  const element = h(
    'div',
    { class: 'flex h-[52px] shrink-0 items-center gap-1 border-b border-[var(--ytt-border)] px-2' },
    [searchWrap, navWrap, viewBtn, tsBtn, copyBtn, exportWrap],
  );

  let menuOpen = false;
  let debounce = 0;
  let lastCopied: boolean | null = null;

  function setMenuOpen(next: boolean): void {
    menuOpen = next;
    exportMenu.classList.toggle('hidden', !next);
  }

  exportBtn.addEventListener('click', () => setMenuOpen(!menuOpen));

  searchInput.addEventListener('input', () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      show(clearBtn, Boolean(searchInput.value));
      show(kbdHint, !searchInput.value);
      options.onQueryChange(searchInput.value);
    }, 120);
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    show(clearBtn, false);
    show(kbdHint, true);
    options.onQueryChange('');
    searchInput.focus();
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }
    if (event.key === 'Escape' && event.target === searchInput) {
      event.stopPropagation();
      searchInput.value = '';
      show(clearBtn, false);
      show(kbdHint, true);
      options.onQueryChange('');
      searchInput.blur();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  const onDocDown = (event: MouseEvent): void => {
    if (!menuOpen) return;
    const path = event.composedPath();
    if (path.includes(exportMenu) || path.includes(exportBtn)) return;
    setMenuOpen(false);
  };
  document.addEventListener('mousedown', onDocDown);

  return {
    element,
    update(view) {
      setText(countEl, view.matchCount > 0 ? `${view.cursor + 1}/${view.matchCount}` : '');
      show(navWrap, view.matchCount > 0);
      tsBtn.disabled = !view.timestampsAvailable;
      tsBtn.title = view.timestampsAvailable
        ? `时间戳：${view.showTimestamps ? '开' : '关'}（显示与复制同步）`
        : '这个字幕没有时间戳';
      tsBtn.classList.toggle('bg-[var(--ytt-accent-soft)]', view.showTimestamps);
      tsBtn.classList.toggle('text-[var(--ytt-accent)]', view.showTimestamps);

      viewBtn.disabled = !view.chaptersAvailable;
      viewBtn.title = view.chaptersAvailable ? '切换 字幕 / 章节' : '这个视频没有章节';
      setText(viewLabel, view.view === 'chapters' ? '章节' : '字幕');
      viewBtn.classList.toggle('border-[var(--ytt-accent)]', view.view === 'chapters');
      viewBtn.classList.toggle('text-[var(--ytt-accent)]', view.view === 'chapters');

      copyBtn.disabled = view.disabled;
      copyBtn.title = copyBtn.disabled
        ? '复制全部'
        : `复制${view.view === 'chapters' ? '章节' : '字幕'}（${view.showTimestamps ? '带时间' : '不带时间'}）`;
      exportBtn.disabled = view.disabled;
      // 播放时每 ~250ms 就会 render 一次，图标只在状态真的变了才重建
      if (view.copied !== lastCopied) {
        lastCopied = view.copied;
        copyBtn.replaceChildren(icon(view.copied ? 'check' : 'copy'));
        copyBtn.classList.toggle('text-[var(--ytt-ok)]', view.copied);
      }
    },
    setQuery(value) {
      searchInput.value = value;
      show(clearBtn, Boolean(value));
      show(kbdHint, !value);
    },
    focusSearch() {
      searchInput.focus();
    },
    closeMenu() {
      setMenuOpen(false);
    },
    destroy() {
      window.clearTimeout(debounce);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onDocDown);
      element.remove();
    },
  };
}
