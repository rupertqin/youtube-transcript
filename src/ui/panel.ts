import { clearCache } from '../core/cache';
import { langMatches, pickUsableChoice } from '../core/langs';
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
import { renderEmptyState, type EmptyKind } from './empty-state';
import { createHeader } from './header';
import { getPrefs, loadPrefs, onThemeResolved, setPrefs, subscribePrefs } from './prefs';
import { applyRowState, createRow } from './row';
import { buildIndex } from './search';
import { createStatusBar } from './statusbar';
import { createToolbar, type ToolbarHandle } from './toolbar';
import { createVirtualList, type VirtualListHandle } from './virtual-list';

const THEME_ORDER = ['dark', 'light', 'system'] as const;

/**
 * 面板状态是否属于「别的视频」。
 *
 * 只要地址栏能读到 id 且与面板状态不一致，就判定为陈旧：此时界面上的一切
 * （标题、行、复制按钮）都是过期数据，必须整体退场。返回 false 的两种情况
 * 都是「无法判断」——没有地址栏 id，或面板还没绑定视频，都不该误杀。
 */
export function isStalePanelState(
  videoId: string | null | undefined,
  pageVideoId: string | null | undefined,
): boolean {
  if (!videoId || !pageVideoId) return false;
  return videoId !== pageVideoId;
}

export interface PanelOptions {
  client: TranscriptClient;
  /** sidebar = 嵌进 YouTube 右栏的卡片；sidepanel = 扩展侧栏；overlay = 旧浮层 */
  variant: 'overlay' | 'sidepanel' | 'sidebar';
  onClose?: () => void;
  /**
   * 地址栏当前视频。用来做「可见即正确」的闸门：
   * 面板状态与它不一致时绝不渲染旧内容，只显示切换中，从 UI 层断掉
   * 「切页后一直显示上一个视频」这种可能。
   */
  currentVideoId?: () => string | null;
}

export interface PanelHandle {
  element: HTMLElement;
  relayout(): void;
  /**
   * 主动重画一次。用于「页面视频变了但 store 还没变」的窗口期：
   * 新鲜度闸门要靠它立刻把旧内容退掉，而不是等下一次 store 通知。
   */
  refresh(): void;
  destroy(): void;
}

export function createPanel(options: PanelOptions): PanelHandle {
  const { client, variant, onClose, currentVideoId } = options;

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
  /** 面板状态是否属于「别的视频」——为真时一律不渲染旧内容 */
  let staleNow = false;
  let staleKey = '';

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
   * 这条视频能不能出某种语言的字幕。
   * availableLangs = 原生轨道 ∪ YouTube 支持的翻译目标；空数组表示还没读到或没有字幕，
   * 这时一个语言按钮都不显示 —— 给一个点了没反应的按钮更糟。
   */
  const hasLang = (target: 'zh' | 'en'): boolean =>
    state.availableLangs.some((code) => langMatches(code, target));

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
    // 再点一次已选中的语言 = 回到「同音频」
    onSelectLang: (choice) => setPrefs({ lang: getPrefs().lang === choice ? 'auto' : choice }),
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
  const statusBar = createStatusBar({
    onClearCache: () => {
      // 用户怀疑缓存时能一键自证：清掉再抓一次，命中缓存这条线就排除了
      void clearCache().then(() => client.load(true));
    },
  });

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

  /**
   * 副标题只说「状态 / 内容从哪来」，**不再报行数** ——
   * 行数底栏已经有了（`⧉ 147`），两处一起显示等于同一句话写两遍。
   */
  /**
   * 副标题只说**正在进行/失败**这两件事，抓成功后整行隐藏。
   *
   * 来源（`DOM`/`播放器`…）和行数底栏已经有了，再在这儿说一遍就是重复；
   * 「章节来自页面信息」这类话更是没人需要。空串会被 header 直接隐藏。
   */
  const subtitleText = (): string => {
    if (state.status === 'error') return '抓取失败';
    if (state.status === 'loading' || state.status === 'idle') return state.progress || '抓取中…';
    return '';
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
    // 复制走 core/format/copy.ts 的唯一实现，视图/时间戳/清洗规则只有一份
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
      // 视频给不了所选语言时按「同音频」显示：按钮不选中，与实际抓取行为一致
      lang: pickUsableChoice(getPrefs().lang, state.availableLangs),
      // 中/英都没有就整组隐藏；有哪个就哪个可点，缺的那个置灰
      showLangGroup: hasLang('zh') || hasLang('en'),
      zhAvailable: hasLang('zh'),
      enAvailable: hasLang('en'),
      copied,
      // 章节是页面独立数据：字幕抓取失败时仍可查看/复制章节
      disabled: staleNow || !(viewRows().length > 0),
    });
  }

  function renderEmpty(): void {
    if (staleNow) {
      // 闸门生效：列表整体退场，只留一个「切换中」骨架
      show(listHost, false);
      show(emptyHost, true);
      const key = `stale|${staleKey}`;
      if (key === emptyKey) return;
      emptyKey = key;
      clear(emptyHost);
      emptyHost.appendChild(renderEmptyState({ kind: 'loading', progress: '正在切换到新视频…' }));
      return;
    }

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
        onClearSearch: () => applyQuery(''),
      }),
    );
  }

  function render(): void {
    if (state.status === 'idle' && state.videoId && state.videoId !== loadedFor) {
      loadedFor = state.videoId;
      void client.load();
    }

    // 新鲜度闸门：状态必须属于地址栏现在这条视频。
    // 两者不一致时（切页后的窗口期、或会话因故没跟上），一律不渲染旧内容 ——
    // 宁可显示「正在切换」，也绝不把上一个视频的字幕和标题当成当前的给人看。
    const pageId = currentVideoId?.() ?? null;
    staleNow = isStalePanelState(state.videoId, pageId);
    staleKey = staleNow ? `${pageId}|${state.videoId}` : '';

    header.setTitle(staleNow ? '正在切换到新视频…' : state.title || 'Transcript Studio');
    header.setSubtitle(staleNow ? '同步中…' : subtitleText());
    statusBar.update(state, pageId);

    if (staleNow) {
      const gateKey = `stale|${staleKey}`;
      if (gateKey !== listKey) {
        listKey = gateKey;
        indexMap = [];
        positions = [];
        listCount = 0;
        list.setCount(0);
        lastActive = -1;
      }
      renderToolbar();
      renderEmpty();
      return;
    }

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

  let lastLang = getPrefs().lang;
  const unsubscribePrefs = subscribePrefs(() => {
    applyTheme();
    // 换语言 = 换内容：必须重抓。缓存按语言分开存，所以这里要强制绕过缓存，
    // 否则「切到中文」会直接命中上次的英文。
    if (getPrefs().lang !== lastLang) {
      lastLang = getPrefs().lang;
      void client.load(true);
    }
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
    refresh: () => render(),
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
