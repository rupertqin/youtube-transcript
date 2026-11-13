import { copyText, downloadFile } from '../core/io';
import { findChapterIndex } from '../core/lines';
import {
  buildExport,
  fileExtension,
  mimeFor,
  slugifyTitle,
  toPlainText,
} from '../core/format/export';
import { formatCopyText } from '../core/format/copy';
import { frameAt } from '../core/storyboard';
import type { ExportFormat, PanelState, TranscriptLine } from '../core/types';
import type { TranscriptClient } from '../platform/types';
import { clear, h, show } from './dom';
import { dumpPageStructure } from '../core/dom/dump';
import { renderEmptyState, type EmptyKind } from './empty-state';
import { createHeader } from './header';
import { SOURCE_LABEL } from './labels';
import { getPrefs, loadPrefs, onThemeResolved, setPrefs, subscribePrefs } from './prefs';
import { applyRowState, createRow } from './row';
import { buildIndex } from './search';
import { createStatusBar } from './statusbar';
import { createToolbar, type ToolbarHandle } from './toolbar';
import { createVirtualList, type VirtualListHandle } from './virtual-list';

const THEME_ORDER = ['dark', 'light', 'system'] as const;

export interface PanelOptions {
  client: TranscriptClient;
  variant: 'overlay' | 'sidepanel';
  onClose?: () => void;
}

export interface PanelHandle {
  element: HTMLElement;
  relayout(): void;
  destroy(): void;
}

export function createPanel(options: PanelOptions): PanelHandle {
  const { client, variant, onClose } = options;

  let state: PanelState = client.getState();
  let needle = '';
  let cursor = 0;
  let copied = false;
  let indexMap: number[] = [];
  let positions: number[] = [];
  /** 上一次交给虚拟列表的行数，用于判断需要 setCount 还是 refresh */
  let listCount = 0;
  let listKey = '';
  let emptyKey = '';
  let lastManualScroll = 0;
  let lastActive = -1;
  let loadedFor = '';
  let followedKey = '';
  let stopTheme: (() => void) | null = null;

  /**
   * 实际生效的视图：偏好是 chapters 但这个视频没有章节时回退到字幕，
   * 否则切到无章节视频会卡在一个永远空着的列表里。
   */
  const currentView = (): 'lines' | 'chapters' =>
    getPrefs().view === 'chapters' && state.chapters.length > 0 ? 'chapters' : 'lines';

  /** 当前视图的数据源：字幕或章节。搜索、渲染、复制、导出都只认这一份。 */
  const viewRows = (): TranscriptLine[] =>
    currentView() === 'chapters' ? state.chapters : state.lines;

  const showTimestamps = (): boolean =>
    getPrefs().timestamps && viewRows().some((line) => line.start >= 0);

  /**
   * 章节高亮按「真实播放位置落在哪个章节区间」算。
   *
   * 不能用 state.lines[activeIndex].start —— 那是一条字幕行的起点，必然
   * **早于**章节起点（章节 28:14 对应的字幕行可能是 28:09），拿它比较就会
   * 一直命中上一个章节，也就是「总是高亮上一章」。
   */
  const activeForView = (): number => {
    if (currentView() !== 'chapters') return state.activeIndex;
    return findChapterIndex(viewRows(), state.positionMs);
  };

  /* ---------------- header ---------------- */
  const header = createHeader({ onCycleTheme: cycleTheme, onClose });

  function cycleTheme(): void {
    const index = THEME_ORDER.indexOf(getPrefs().theme);
    setPrefs({ theme: THEME_ORDER[(index + 1) % THEME_ORDER.length] });
  }

  /* ---------------- toolbar ---------------- */
  const toolbar: ToolbarHandle = createToolbar({
    onQueryChange: (value) => applyQuery(value),
    onJump: (direction) => jump(direction),
    onToggleTimestamps: () => setPrefs({ timestamps: !getPrefs().timestamps }),
    onToggleView: () => {
      if (state.chapters.length === 0) return;
      needle = '';
      toolbar.setQuery('');
      setPrefs({ view: getPrefs().view === 'chapters' ? 'lines' : 'chapters' });
    },
    onCopy: () => void handleCopy(),
    onExport: (format) => handleExport(format),
  });

  /* ---------------- list ---------------- */
  const emptyHost = h('div', { class: 'h-full' });
  const listHost = h('div', { class: 'relative h-full' });

  const list: VirtualListHandle = createVirtualList({
    renderRow: (index) => renderRow(index),
    onUserScroll: () => {
      lastManualScroll = Date.now();
    },
  });

  listHost.appendChild(list.element);
  listHost.appendChild(
    h('div', {
      class: 'pointer-events-none absolute inset-x-0 top-0 h-3 bg-gradient-to-b from-[var(--ytt-bg)] to-transparent',
    }),
  );
  listHost.appendChild(
    h('div', {
      class: 'pointer-events-none absolute inset-x-0 bottom-0 h-3 bg-gradient-to-t from-[var(--ytt-bg)] to-transparent',
    }),
  );

  const main = h('main', { class: 'relative min-h-0 flex-1' }, [listHost, emptyHost]);

  /* ---------------- status ---------------- */
  const statusBar = createStatusBar();

  const root = h(
    'div',
    { class: 'ytt-root relative flex h-full min-h-0 flex-col bg-[var(--ytt-bg)] text-[var(--ytt-text)]' },
    [header.element, toolbar.element, main, statusBar.element],
  );

  if (variant === 'overlay') {
    root.appendChild(
      h('div', {
        class: 'pointer-events-none absolute inset-0 rounded-[14px] ring-1 ring-inset ring-white/[0.04]',
      }),
    );
  }

  /* ---------------- 行渲染 ---------------- */
  function renderRow(index: number): HTMLElement {
    const original = indexMap[index] ?? index;
    const line = viewRows()[original];
    if (!line) return h('div');

    return createRow({
      line,
      original,
      active: original === activeForView(),
      showTimestamps: showTimestamps(),
      needle,
      // 只有章节视图放截图：字幕动辄几千行，逐行拉雪碧图没有意义
      thumb: currentView() === 'chapters' ? frameAt(state.storyboard, line.start) : null,
      onSeek: (seconds) => client.seek(seconds),
    });
  }

  /* ---------------- 派生状态 ---------------- */
  function rebuildIndex(): void {
    const rows = viewRows();
    const { matches } = buildIndex(rows, needle);
    indexMap = needle.trim() ? matches : rows.map((_, index) => index);
    positions = new Array(rows.length).fill(-1);
    indexMap.forEach((original, position) => {
      positions[original] = position;
    });
  }

  const subtitleText = (): string => {
    const rows = viewRows();
    if (rows.length > 0) {
      const unit = currentView() === 'chapters' ? '个章节' : '行';
      const source = currentView() === 'chapters' ? '页面章节' : (state.source ? SOURCE_LABEL[state.source] : '未知来源');
      return `${rows.length} ${unit} · ${source}`;
    }
    if (state.status === 'loading' || state.status === 'idle') return '抓取中…';
    if (state.status === 'error') return '抓取失败';
    return '等待抓取';
  };

  const exportMeta = () => ({
    title: state.title,
    videoId: state.videoId,
    url: `https://www.youtube.com/watch?v=${state.videoId}`,
    lang: state.lang,
    source: state.source,
  });

  function applyQuery(value: string): void {
    needle = value;
    cursor = 0;
    toolbar.setQuery(value);
    render();
    list.scrollToTop();
  }

  function jump(direction: 1 | -1): void {
    if (indexMap.length === 0) return;
    cursor = (cursor + direction + indexMap.length) % indexMap.length;
    list.scrollToIndex(cursor);
    renderToolbar();
  }

  /** 两个入口共用的复制参数：带不带时间、当前视图、是否附章节。 */
  const copyOptions = () => ({
    // 用回退后的实际视图，避免「偏好 chapters 但没章节」时参数与数据源不一致
    view: currentView(),
    // 视图里没有时间戳可用时（例如章节缺时间）强制不带，避免输出 --:--
    timestamps: showTimestamps(),
    chapters: state.chapters,
  });

  async function handleCopy(): Promise<void> {
    // 与原版 Copy Transcript 调用同一个 formatCopyText，输出必然一致
    const text = formatCopyText(viewRows(), copyOptions());
    const ok = await copyText(text || toPlainText(viewRows(), { timestamps: showTimestamps() }));
    if (!ok) return;
    copied = true;
    renderToolbar();
    window.setTimeout(() => {
      copied = false;
      renderToolbar();
    }, 1500);
  }

  function handleExport(format: ExportFormat): void {
    const rows = viewRows();
    const content = format === 'txt'
      ? (formatCopyText(rows, copyOptions()) || toPlainText(rows, { timestamps: showTimestamps() }))
      : buildExport(format, rows, exportMeta(), showTimestamps());
    const suffix = currentView() === 'chapters' ? '-chapters' : '';
    downloadFile(`${slugifyTitle(state.title)}${suffix}.${fileExtension(format)}`, content, mimeFor(format));
  }

  function renderToolbar(): void {
    toolbar.update({
      matchCount: needle.trim() ? indexMap.length : 0,
      cursor,
      showTimestamps: showTimestamps(),
      timestampsAvailable: viewRows().some((line) => line.start >= 0),
      view: currentView(),
      chaptersAvailable: state.chapters.length > 0,
      copied,
      // 章节是页面独立数据：字幕抓取失败时仍可查看/复制章节
      disabled: !(viewRows().length > 0),
    });
  }

  function renderEmpty(): void {
    const rows = viewRows();
    // 章节视图只依赖页面数据，字幕抓取失败也能正常显示
    const ready = rows.length > 0 && (currentView() === 'chapters' || state.status === 'ready');
    const searchEmpty = Boolean(needle.trim()) && indexMap.length === 0 && rows.length > 0;
    const visibleList = ready && !searchEmpty;

    show(listHost, visibleList);
    show(emptyHost, !visibleList);
    if (visibleList) {
      emptyKey = '';
      return;
    }

    let kind: EmptyKind = 'nodata';
    if (searchEmpty) kind = 'nomatch';
    else if (state.status === 'loading' || state.status === 'idle') kind = 'loading';
    else if (state.status === 'error') kind = 'error';

    const key = `${kind}|${state.error?.code ?? ''}|${state.error?.detail ?? ''}|${needle}|${state.progress ?? ''}|${state.diagnostic ?? ''}`;
    if (key === emptyKey) return;
    emptyKey = key;

    clear(emptyHost);
    emptyHost.appendChild(
      renderEmptyState({
        kind,
        code: state.error?.code ?? null,
        detail: state.error?.detail,
        needle,
        progress: state.progress,
        diagnostic: state.diagnostic,
        onRetry: () => void client.load(true),
        onDump: async () => copyText(dumpPageStructure(document)),
        onClearSearch: () => applyQuery(''),
      }),
    );
  }

  function render(): void {
    if (state.status === 'idle' && state.videoId && state.videoId !== loadedFor) {
      loadedFor = state.videoId;
      void client.load();
    }

    header.setTitle(state.title || 'Transcript Studio');
    header.setSubtitle(subtitleText());
    statusBar.update(state);

    // 时间戳开关会改变行结构（有没有时间列），视图切换会换整份数据，
    // storyboard 是异步到的（扩展要过桥），到了也要重渲染出截图 —— 都纳入 key
    // storyboard 只在章节视图影响渲染，字幕视图不必为它重建几千行
    const storyboardKey = currentView() === 'chapters' && state.storyboard ? 'sb' : '';
    const key =
      `${state.videoId}|${state.updatedAt}|${needle}|${showTimestamps()}` +
      `|${currentView()}|${state.chapters.length}|${storyboardKey}`;
    if (key !== listKey) {
      listKey = key;
      rebuildIndex();
      // 时间戳开关 / 视图切换时行数往往不变，setCount 会直接返回、行不重建。
      // 行数没变就走 refresh()，保证开关立刻反映到 UI 上。
      if (indexMap.length === listCount) {
        list.refresh();
      } else {
        listCount = indexMap.length;
        list.setCount(indexMap.length);
      }
      renderToolbar();
      renderEmpty();
      lastActive = activeForView();

      const followKey = `${state.videoId}|${needle}|${currentView()}`;
      if (followKey !== followedKey && viewRows().length > 0 && activeForView() >= 0) {
        followedKey = followKey;
        const position = positions[activeForView()];
        // 等首屏行测量完再跳，否则用的是估算高度
        if (position >= 0) requestAnimationFrame(() => list.scrollToIndex(position, 'center'));
      }
      return;
    }

    renderToolbar();
    renderEmpty();

    const active = activeForView();
    list.eachMounted((_, row) => applyRowState(row, Number(row.dataset.original) === active, showTimestamps()));

    if (active !== lastActive) {
      lastActive = active;
      const position = positions[active];
      if (position >= 0 && Date.now() - lastManualScroll > 3000) list.scrollToIndex(position);
    }
  }

  /* ---------------- 主题 ---------------- */
  const applyTheme = (): void => {
    stopTheme?.();
    const prefs = getPrefs();
    stopTheme = onThemeResolved(prefs.theme, (resolved) => {
      root.classList.toggle('ytt-light', resolved === 'light');
      header.setTheme(prefs.theme);
    });
  };

  const unsubscribePrefs = subscribePrefs(() => {
    applyTheme();
    render();
  });

  const unsubscribe = client.subscribe((next) => {
    state = next;
    render();
  });

  applyTheme();
  void loadPrefs();
  render();

  return {
    element: root,
    relayout: () => list.relayout(),
    destroy() {
      unsubscribe();
      unsubscribePrefs();
      stopTheme?.();
      toolbar.destroy();
      statusBar.closePopover();
      list.destroy();
      root.remove();
    },
  };
}
