import type { FailureRecord, PanelState, SourceName } from '../core/types';
import { clear, h, setText, show } from './dom';
import { icon } from './icons';
import { SOURCE_HINT, SOURCE_LABEL } from './labels';

/** 一次就命中时，说清楚是哪一层命中的（链路顺序：DOM → 拦截 → 播放器）。 */
const SOURCE_HIT_TEXT: Record<SourceName, string> = {
  dom: 'DOM 层直接命中：读的是页面上已渲染的原生面板，那一下不发任何请求。',
  player: '播放器层直接命中：用的是播放器响应里的字幕轨道。',
  intercept: '拦截层直接命中：用的是 YouTube 自己发出的字幕请求结果。',
  innertube: 'InnerTube 层直接命中：播放器响应不可用，重新探测拿到了轨道。',
};

export interface StatusBarOptions {
  /** 诊断面板里的「清空缓存」：清完立刻重新抓当前视频 */
  onClearCache?: () => void;
}

export interface StatusBarHandle {
  element: HTMLElement;
  /** pageVideoId：地址栏当前视频，用来和面板所属视频对照 */
  update(state: PanelState, pageVideoId?: string | null): void;
  closePopover(): void;
}

export function createStatusBar(options: StatusBarOptions = {}): StatusBarHandle {
  const sourceIcon = icon('activity', 11);
  const sourceText = h('span', { text: '未抓取' });
  const sourceWrap = h('span', { class: 'inline-flex items-center gap-1' }, [sourceIcon, sourceText]);

  const countText = h('span', { text: '0' });
  const countWrap = h('span', { class: 'inline-flex items-center gap-1' }, [icon('list', 11), countText]);

  const langText = h('span', { class: 'truncate uppercase' });

  const cacheWrap = h(
    'span',
    {
      class:
        'inline-flex items-center gap-1 rounded border border-[var(--ytt-border)] px-1 py-[1px] text-[11px] uppercase tracking-wide',
    },
    [icon('database', 9), h('span', { text: '缓存' })],
  );
  show(cacheWrap, false);

  const diagLabel = h('span', { text: '诊断' });
  const diagBtn = h(
    'button',
    {
      class:
        'inline-flex items-center gap-1 rounded px-1 py-[1px] transition hover:bg-[var(--ytt-hover)] hover:text-[var(--ytt-text-dim)]',
      attrs: { type: 'button', title: '查看抓取诊断' },
    },
    [icon('alert', 10), diagLabel],
  );

  const popover = h('div', {
    class:
      'ytt-scroll absolute bottom-full left-0 right-0 max-h-[180px] overflow-y-auto border-t border-[var(--ytt-border)] bg-[var(--ytt-bg-elev)] px-3 py-2',
  });
  show(popover, false);

  // 版本号常驻底栏：排查时第一件事就是确认装的是哪一版
  const versionText = h('span', {
    class: 'shrink-0 text-[11px] tabular-nums',
    text: `v${typeof __YTT_VERSION__ === 'string' ? __YTT_VERSION__ : 'dev'}`,
  });
  versionText.style.opacity = '0.65';

  const footer = h(
    'footer',
    { class: 'flex h-9 items-center gap-2.5 px-4 text-[12px] text-[var(--ytt-text-mute)]' },
    [sourceWrap, countWrap, langText, cacheWrap, h('span', { class: 'flex-1' }), versionText, diagBtn],
  );

  const element = h('div', { class: 'relative shrink-0 border-t border-[var(--ytt-border)]' }, [popover, footer]);

  let open = false;
  let failuresKey = '';

  const row = (label: string, value: string, bad = false): HTMLElement =>
    h('div', { class: 'flex items-center gap-2 text-[12px] leading-snug' }, [
      h('span', { class: 'w-[64px] shrink-0 text-[var(--ytt-text-mute)]', text: label }),
      h('span', {
        class:
          'min-w-0 flex-1 truncate font-mono text-[11px] ' +
          (bad ? 'text-[var(--ytt-err)]' : 'text-[var(--ytt-text-dim)]'),
        title: value,
        text: value,
      }),
    ]);

  const renderPopover = (state: PanelState, pageVideoId: string | null): void => {
    clear(popover);

    // 归属自检：这两个 id 不一致时，面板里一定不是当前视频的内容
    const mismatch = Boolean(state.videoId && pageVideoId && state.videoId !== pageVideoId);
    popover.appendChild(
      h('p', {
        class: 'mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--ytt-text-mute)]',
        text: '归属自检',
      }),
    );
    popover.appendChild(row('当前页面', pageVideoId || '—'));
    popover.appendChild(row('面板所属', state.videoId || '—', mismatch));
    popover.appendChild(
      row(
        '来源',
        state.cached
          ? `${state.source ? SOURCE_LABEL[state.source] : '未知'}（缓存命中）`
          : state.source
            ? SOURCE_LABEL[state.source]
            : '未抓取',
      ),
    );
    // 章节截图只靠 storyboard 规格串：没有它就整列空白，值得单独报一行
    popover.appendChild(row('章节截图', state.storyboard ? '规格已就绪' : '未取到规格'));

    if (mismatch) {
      popover.insertBefore(
        h('p', {
          class: 'mt-1 text-[11px] leading-snug text-[var(--ytt-err)]',
          text: '两者不一致：面板内容是别的视频的，正在自动纠正。',
        }),
        popover.firstChild,
      );
    }
    popover.appendChild(
      h('p', {
        class: 'mt-1 text-[11px] leading-snug text-[var(--ytt-text-mute)]',
        text: '缓存按视频独立存放，7 天过期，不会跨视频复用。',
      }),
    );

    if (options.onClearCache) {
      popover.appendChild(
        h('button', {
          class:
            'mt-2 rounded border border-[var(--ytt-border-strong)] px-2 py-1 text-[12px] text-[var(--ytt-text)] transition hover:bg-[var(--ytt-hover)]',
          attrs: { type: 'button' },
          on: { click: () => options.onClearCache?.() },
          text: '清空缓存并重新抓取',
        }),
      );
    }

    const failures = state.failures ?? [];
    popover.appendChild(
      h('p', {
        class: 'mt-2 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--ytt-text-mute)]',
        text: '抓取链路',
      }),
    );

    if (failures.length === 0) {
      // 链路的顺序是 DOM → 拦截 → 播放器（POT 环境下 DOM 最可靠，所以排在最前），
      // 只说「第一层」会让人以为是播放器 —— 直接把命中的那一层名字写出来。
      popover.appendChild(
        h('p', {
          class: 'text-[12px] leading-snug text-[var(--ytt-text-dim)]',
          text: state.source ? SOURCE_HIT_TEXT[state.source] : '还没有抓取结果。',
        }),
      );
      return;
    }

    const list = h('ul', { class: 'space-y-1' });
    for (const failure of failures) {
      const source = SOURCE_LABEL[failure.source as SourceName] ?? failure.source;
      list.appendChild(
        h('li', { class: 'flex items-start gap-2 text-[12px] leading-snug' }, [
          h('span', { class: 'w-[52px] shrink-0 text-[var(--ytt-text-mute)]', text: source }),
          h('span', { class: 'w-[104px] shrink-0 font-mono text-[11px] text-[var(--ytt-warn)]', text: failure.code }),
          h('span', { class: 'w-9 shrink-0 tabular-nums text-[var(--ytt-text-mute)]', text: `${failure.ms}ms` }),
          h('span', {
            class: 'min-w-0 flex-1 truncate text-[var(--ytt-text-dim)]',
            title: failure.detail ?? '—',
            text: failure.detail ?? '—',
          }),
        ]),
      );
    }
    popover.appendChild(list);
  };

  diagBtn.addEventListener('click', () => {
    open = !open;
    show(popover, open);
  });

  return {
    element,
    update(state, pageVideoId = null) {
      setText(sourceText, state.source ? SOURCE_LABEL[state.source] : '未抓取');
      // `DOM` 这类缩写只在悬停时解释一句，省得去翻文档
      sourceWrap.title = state.source ? SOURCE_HINT[state.source] : '还没有抓到字幕';
      sourceIcon.style.color = state.source ? 'var(--ytt-ok)' : '';
      setText(countText, String(state.lines.length));
      setText(langText, state.lang ?? '');
      show(cacheWrap, state.cached);
      show(langText, Boolean(state.lang));

      const failures = state.failures ?? [];
      const key = [
        state.videoId,
        pageVideoId ?? '',
        state.cached ? 'cache' : 'live',
        state.source ?? '',
        ...failures.map((f) => `${f.source}:${f.code}:${f.ms}`),
      ].join('|');
      if (key !== failuresKey) {
        failuresKey = key;
        renderPopover(state, pageVideoId);
      }

      diagBtn.classList.toggle('text-[var(--ytt-warn)]', failures.length > 0);
      setText(diagLabel, failures.length > 0 ? `诊断 ${failures.length}` : '诊断');
    },
    closePopover() {
      open = false;
      show(popover, false);
    },
  };
}
