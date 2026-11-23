import type { LangChoice } from '../core/langs';
import type { ContentView, ExportFormat } from '../core/types';
import { h, setText, show } from './dom';
import { icon } from './icons';
import type { FontSizePref, LineSpacingPref } from './prefs';

const ICON_BTN =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--ytt-text-dim)] transition ' +
  'hover:bg-[var(--ytt-hover)] hover:text-[var(--ytt-text)] active:scale-95 ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

/** 第二行里带文字的小胶囊（视图 / 语言），和图标按钮同高 */
const PILL_BTN =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--ytt-border)] ' +
  'px-2.5 text-[13px] font-medium text-[var(--ytt-text-dim)] transition ' +
  'hover:bg-[var(--ytt-hover)] hover:text-[var(--ytt-text)] ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

const EXPORTS: { format: ExportFormat; label: string; hint: string }[] = [
  { format: 'txt', label: '纯文本', hint: '.txt' },
  { format: 'md', label: 'Markdown', hint: '.md' },
  { format: 'srt', label: '字幕文件', hint: '.srt' },
  { format: 'json', label: '结构化', hint: '.json' },
];

/** 阅读设置里的分段选项：字号 / 行距 */
const FONT_SIZES: { value: FontSizePref; label: string; hint: string }[] = [
  { value: 'sm', label: '小', hint: '13px' },
  { value: 'md', label: '标准', hint: '14px' },
  { value: 'lg', label: '大', hint: '16px' },
];
const LINE_SPACINGS: { value: LineSpacingPref; label: string }[] = [
  { value: 'tight', label: '紧' },
  { value: 'normal', label: '标准' },
  { value: 'loose', label: '松' },
];
/** 分段按钮：选中态只改背景和文字色，尺寸不变（避免切换时行宽跳动） */
const OPT_BTN =
  'flex-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-[var(--ytt-text-dim)] transition ' +
  'hover:bg-[var(--ytt-hover)] hover:text-[var(--ytt-text)]';
const OPT_ON_BG = 'bg-[var(--ytt-accent-soft)]';
const OPT_ON_TEXT = 'text-[var(--ytt-accent)]';

export interface ToolbarView {
  matchCount: number;
  cursor: number;
  showTimestamps: boolean;
  timestampsAvailable: boolean;
  /** 当前展示/复制的是字幕还是章节 */
  view: ContentView;
  chaptersAvailable: boolean;
  /** 这个站点有没有章节（B 站没有 → 整组视图按钮隐藏，不给永远点不动的按钮） */
  canChapters: boolean;
  /** 站点是否支持机器翻译：不支持时语言缺口的提示要说清楚 */
  machineTranslate: boolean;
  /** 当前选中的字幕语言；auto = 同音频（两个按钮都不高亮） */
  lang: LangChoice;
  /** 中/英至少有一个可用时才显示这组按钮；两个都没有就整组隐藏 */
  showLangGroup: boolean;
  /** 能不能出中文 / 英文字幕（原生轨道或机翻目标）。不能则该按钮 disabled */
  zhAvailable: boolean;
  enAvailable: boolean;
  /** 阅读排版：正文字号档位 / 行距档位 */
  fontSize: FontSizePref;
  lineSpacing: LineSpacingPref;
  copied: boolean;
  disabled: boolean;
}

export interface ToolbarOptions {
  onQueryChange: (value: string) => void;
  onJump: (direction: 1 | -1) => void;
  onToggleTimestamps: () => void;
  onToggleView: () => void;
  /** 选中的按钮再点一次 = 回到「同音频」 */
  onSelectLang: (choice: 'zh' | 'en') => void;
  onFontSize: (size: FontSizePref) => void;
  onLineSpacing: (spacing: LineSpacingPref) => void;
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
      'h-full min-w-0 flex-1 bg-transparent text-[14px] text-[var(--ytt-text)] placeholder:text-[var(--ytt-text-mute)]',
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
    class: 'shrink-0 rounded border border-[var(--ytt-border)] px-1 text-[11px] text-[var(--ytt-text-mute)]',
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

  // 原版的搜索框是**胶囊**：40px 高、全圆角、左右 14px。照着来，别用方角。
  const searchWrap = h(
    'div',
    {
      class:
        'flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full border border-transparent bg-[var(--ytt-surface)] px-3.5 transition focus-within:border-[var(--ytt-border-strong)] focus-within:bg-[var(--ytt-bg-elev)]',
    },
    [searchGlyph, searchInput, kbdHint, clearBtn],
  );

  const countEl = h('span', { class: 'px-1 text-[12px] tabular-nums text-[var(--ytt-text-mute)]' });
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

  // 字幕语言：中文 / English 两个按钮，都不选中 = 同音频（默认）。
  // 视频给不了的语言按钮置灰（不隐藏：直接消失会让人以为是 bug）。
  const langPill = (text: string, choice: 'zh' | 'en', label: string): HTMLButtonElement =>
    h(
      'button',
      {
        class: PILL_BTN,
        attrs: { type: 'button', 'aria-label': label, title: label },
        on: { click: () => options.onSelectLang(choice) },
      },
      [h('span', { text })],
    ) as HTMLButtonElement;

  const zhBtn = langPill('中', 'zh', '中文字幕');
  const enBtn = langPill('EN', 'en', 'English subtitles');
  const langWrap = h(
    'div',
    { class: 'inline-flex shrink-0 items-center gap-1', attrs: { 'aria-label': '字幕语言' } },
    [icon('globe', 12), zhBtn, enBtn],
  );

  // 字幕 / 章节 视图切换：两个入口共用同一份 prefs，切换后原版按钮复制的内容也跟着变
  const viewLabel = h('span', { text: '字幕' });
  const viewBtn = h(
    'button',
    {
      class: PILL_BTN,
      attrs: { type: 'button', 'aria-label': '切换字幕/章节' },
      on: { click: () => options.onToggleView() },
    },
    [icon('list', 13), viewLabel],
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
      'absolute right-0 top-9 z-30 hidden w-[168px] overflow-hidden rounded-xl border border-[var(--ytt-border-strong)] bg-[var(--ytt-bg-elev)] py-1.5 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.65)]',
  });

  for (const item of EXPORTS) {
    exportMenu.appendChild(
      h(
        'button',
        {
          class:
            'flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px] text-[var(--ytt-text-dim)] transition hover:bg-[var(--ytt-hover)] hover:text-[var(--ytt-text)]',
          attrs: { type: 'button' },
          on: {
            click: () => {
              setMenu(null);
              options.onExport(item.format);
            },
          },
        },
        [
          h('span', { text: item.label }),
          h('span', { class: 'text-[11px] text-[var(--ytt-text-mute)]', text: item.hint }),
        ],
      ),
    );
  }

  const exportBtn = h(
    'button',
    {
      class: ICON_BTN,
      attrs: {
        type: 'button',
        'aria-label': '导出',
        title: '导出',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
      },
    },
    [icon('download')],
  );

  const exportWrap = h('div', { class: 'relative' }, [exportBtn, exportMenu]);

  /* ---------------- 阅读设置（字号 / 行距） ---------------- */
  const fontBtns = new Map<FontSizePref, HTMLButtonElement>();
  const spacingBtns = new Map<LineSpacingPref, HTMLButtonElement>();

  const optionGroup = <T extends string>(
    title: string,
    items: readonly { value: T; label: string }[],
    store: Map<T, HTMLButtonElement>,
    onPick: (value: T) => void,
  ): HTMLElement =>
    h('div', { class: 'flex flex-col gap-1' }, [
      h('span', { class: 'px-0.5 text-[11px] text-[var(--ytt-text-mute)]', text: title }),
      h(
        'div',
        { class: 'flex items-center gap-1 rounded-lg bg-[var(--ytt-surface)] p-0.5' },
        items.map((item) => {
          const btn = h(
            'button',
            {
              class: OPT_BTN,
              attrs: { type: 'button', 'aria-pressed': 'false' },
              on: { click: () => onPick(item.value) },
            },
            [h('span', { text: item.label })],
          ) as HTMLButtonElement;
          store.set(item.value, btn);
          return btn;
        }),
      ),
    ]);

  const readingMenu = h('div', {
    class:
      'absolute right-0 top-9 z-30 hidden w-[190px] rounded-xl border border-[var(--ytt-border-strong)] ' +
      'bg-[var(--ytt-bg-elev)] p-2.5 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.65)]',
  });
  readingMenu.setAttribute('role', 'menu');

  readingMenu.appendChild(
    h('div', { class: 'flex flex-col gap-2.5' }, [
      optionGroup('字号', FONT_SIZES, fontBtns, (value) => options.onFontSize(value)),
      optionGroup('行距', LINE_SPACINGS, spacingBtns, (value) => options.onLineSpacing(value)),
    ]),
  );

  const typeBtn = h(
    'button',
    {
      class: ICON_BTN,
      attrs: {
        type: 'button',
        'aria-label': '阅读设置',
        title: '字号 / 行距',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
      },
    },
    [icon('type')],
  );

  const typeWrap = h('div', { class: 'relative' }, [typeBtn, readingMenu]);

  /**
   * 两行而不是一行。
   *
   * 右栏只有 ~400px，原来 7 个控件挤在同一行：搜索框被压到 100px 出头，
   * 中/EN、列表、时间戳、复制、导出挤成一条，视觉上非常吵。
   * 拆成「搜索」+「操作」两行后每个控件都回到舒适宽度，代价只有 40px 高度。
   */
  const searchRow = h('div', { class: 'flex h-10 items-center gap-2' }, [searchWrap, navWrap]);

  const divider = h('span', {
    class: 'mx-0.5 h-5 w-px shrink-0 bg-[var(--ytt-border)]',
    attrs: { 'aria-hidden': 'true' },
  });

  const actionRow = h('div', { class: 'flex h-9 items-center gap-1.5' }, [
    viewBtn,
    langWrap,
    divider,
    h('span', { class: 'flex-1' }),
    tsBtn,
    typeWrap,
    copyBtn,
    exportWrap,
  ]);

  const element = h(
    'div',
    { class: 'flex shrink-0 flex-col gap-1.5 border-b border-[var(--ytt-border)] px-4 pb-3 pt-3' },
    [searchRow, actionRow],
  );

  type MenuKind = 'export' | 'reading';
  let openMenu: MenuKind | null = null;
  let debounce = 0;
  let lastCopied: boolean | null = null;

  /** 两个弹出层只能开一个：打开 A 自动收起 B，Esc / 点外面统一关 */
  function setMenu(next: MenuKind | null): void {
    if (next === openMenu) return;
    openMenu = next;
    exportMenu.classList.toggle('hidden', next !== 'export');
    readingMenu.classList.toggle('hidden', next !== 'reading');
    exportBtn.setAttribute('aria-expanded', String(next === 'export'));
    typeBtn.setAttribute('aria-expanded', String(next === 'reading'));
  }

  exportBtn.addEventListener('click', () => setMenu(openMenu === 'export' ? null : 'export'));
  typeBtn.addEventListener('click', () => setMenu(openMenu === 'reading' ? null : 'reading'));

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
    if (event.key !== 'Escape') return;
    // Esc 先管弹出层（不冒泡到 YouTube 页面，否则会把播放器也按一下）
    if (openMenu) {
      event.stopPropagation();
      setMenu(null);
      return;
    }
    if (event.target === searchInput) {
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
    if (!openMenu) return;
    const path = event.composedPath();
    const inside =
      path.includes(exportMenu) ||
      path.includes(exportBtn) ||
      path.includes(readingMenu) ||
      path.includes(typeBtn);
    if (!inside) setMenu(null);
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

      // 中/英都没字幕 → 整组隐藏，不给两个永远点不动的按钮
      show(langWrap, view.showLangGroup);
      const noTranslate = view.machineTranslate ? '' : '（该站点不支持机器翻译）';
      for (const [btn, choice, available, missingHint] of [
        [zhBtn, 'zh', view.zhAvailable, `这个视频没有中文字幕${noTranslate}`],
        [enBtn, 'en', view.enAvailable, `这个视频没有英文字幕${noTranslate}`],
      ] as const) {
        // 有字幕但缺这个语言：按钮留着但禁用，悬停说明原因 —— 直接消失会让人以为是 bug
        btn.disabled = !available;
        btn.title = available ? btn.getAttribute('aria-label') ?? '' : missingHint;
        const on = available && view.lang === choice;
        btn.classList.toggle('border-[var(--ytt-accent)]', on);
        btn.classList.toggle('text-[var(--ytt-accent)]', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }

      // 站点没有章节能力时整组隐藏（B 站）：留一个禁用按钮只会让人反复点
      show(viewBtn, view.canChapters);
      viewBtn.disabled = !view.chaptersAvailable;
      viewBtn.title = view.chaptersAvailable ? '切换 字幕 / 章节' : '这个视频没有章节';
      setText(viewLabel, view.view === 'chapters' ? '章节' : '字幕');
      viewBtn.classList.toggle('border-[var(--ytt-accent)]', view.view === 'chapters');
      viewBtn.classList.toggle('text-[var(--ytt-accent)]', view.view === 'chapters');

      copyBtn.disabled = view.disabled;
      // 禁用时也要说清原因：跟语言/视图按钮一个口径，别让它变成「点不动的按钮」
      copyBtn.title = view.disabled
        ? '暂无可复制的内容'
        : `复制${view.view === 'chapters' ? '章节' : '字幕'}（${view.showTimestamps ? '带时间' : '不带时间'}）`;
      exportBtn.disabled = view.disabled;
      exportBtn.title = view.disabled ? '暂无可导出的内容' : '导出';

      // 阅读设置：只亮当前档位
      for (const [value, btn] of fontBtns) {
        const on = view.fontSize === value;
        btn.classList.toggle(OPT_ON_BG, on);
        btn.classList.toggle(OPT_ON_TEXT, on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      for (const [value, btn] of spacingBtns) {
        const on = view.lineSpacing === value;
        btn.classList.toggle(OPT_ON_BG, on);
        btn.classList.toggle(OPT_ON_TEXT, on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
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
      setMenu(null);
    },
    destroy() {
      window.clearTimeout(debounce);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onDocDown);
      element.remove();
    },
  };
}
