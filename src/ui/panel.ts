import { copyText, downloadFile } from '../core/io';
import {
  buildExport,
  fileExtension,
  mimeFor,
  slugifyTitle,
  toPlainText,
} from '../core/format/export';
import type { ExportFormat, PanelState } from '../core/types';
import type { TranscriptClient } from '../platform/types';
import { clear, h, show } from './dom';
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
  let listKey = '';
  let emptyKey = '';
  let lastManualScroll = 0;
  let lastActive = -1;
  let loadedFor = '';
  let followedKey = '';
  let stopTheme: (() => void) | null = null;

  const showTimestamps = (): boolean =>
    getPrefs().timestamps && state.lines.some((line) => line.start >= 0);

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
    const line = state.lines[original];
    if (!line) return h('div');

    return createRow({
      line,
      original,
      active: original === state.activeIndex,
      showTimestamps: showTimestamps(),
      needle,
      onSeek: (seconds) => client.seek(seconds),
    });
  }

  /* ---------------- 派生状态 ---------------- */
  function rebuildIndex(): void {
    const { matches } = buildIndex(state.lines, needle);
    indexMap = needle.trim() ? matches : state.lines.map((_, index) => index);
    positions = new Array(state.lines.length).fill(-1);
    indexMap.forEach((original, position) => {
      positions[original] = position;
    });
  }

  const subtitleText = (): string => {
    if (state.lines.length > 0) {
      return `${state.lines.length} 行 · ${state.source ? SOURCE_LABEL[state.source] : '未知来源'}`;
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

  async function handleCopy(): Promise<void> {
    const ok = await copyText(toPlainText(state.lines, { timestamps: showTimestamps() }));
    if (!ok) return;
    copied = true;
    renderToolbar();
    window.setTimeout(() => {
      copied = false;
      renderToolbar();
    }, 1500);
  }

  function handleExport(format: ExportFormat): void {
    const content = buildExport(format, state.lines, exportMeta(), showTimestamps());
    downloadFile(`${slugifyTitle(state.title)}.${fileExtension(format)}`, content, mimeFor(format));
  }

  function renderToolbar(): void {
    toolbar.update({
      matchCount: needle.trim() ? indexMap.length : 0,
      cursor,
      showTimestamps: showTimestamps(),
      timestampsAvailable: state.lines.some((line) => line.start >= 0),
      copied,
      disabled: !(state.status === 'ready' && state.lines.length > 0),
    });
  }

  function renderEmpty(): void {
    const ready = state.status === 'ready' && state.lines.length > 0;
    const searchEmpty = Boolean(needle.trim()) && indexMap.length === 0 && state.lines.length > 0;
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

    const key = `${kind}|${state.error?.code ?? ''}|${state.error?.detail ?? ''}|${needle}|${state.progress ?? ''}`;
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

    header.setTitle(state.title || 'Transcript Studio');
    header.setSubtitle(subtitleText());
    statusBar.update(state);

    // 时间戳开关会改变行结构（有没有时间列），一并纳入 key
    const key = `${state.videoId}|${state.updatedAt}|${needle}|${showTimestamps()}`;
    if (key !== listKey) {
      listKey = key;
      rebuildIndex();
      list.setCount(indexMap.length);
      renderToolbar();
      renderEmpty();
      lastActive = state.activeIndex;

      const followKey = `${state.videoId}|${needle}`;
      if (followKey !== followedKey && state.lines.length > 0 && state.activeIndex >= 0) {
        followedKey = followKey;
        const position = positions[state.activeIndex];
        // 等首屏行测量完再跳，否则用的是估算高度
        if (position >= 0) requestAnimationFrame(() => list.scrollToIndex(position, 'center'));
      }
      return;
    }

    renderToolbar();
    renderEmpty();

    list.eachMounted((_, row) => applyRowState(row, Number(row.dataset.original) === state.activeIndex, showTimestamps()));

    if (state.activeIndex !== lastActive) {
      lastActive = state.activeIndex;
      const position = positions[state.activeIndex];
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
