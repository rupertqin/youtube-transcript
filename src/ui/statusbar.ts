import type { FailureRecord, PanelState, SourceName } from '../core/types';
import { clear, h, setText, show } from './dom';
import { icon } from './icons';
import { SOURCE_LABEL } from './labels';

export interface StatusBarHandle {
  element: HTMLElement;
  update(state: PanelState): void;
  closePopover(): void;
}

export function createStatusBar(): StatusBarHandle {
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
        'inline-flex items-center gap-1 rounded border border-[var(--ytt-border)] px-1 py-[1px] text-[9.5px] uppercase tracking-wide',
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

  const footer = h(
    'footer',
    { class: 'flex h-8 items-center gap-2 px-3 text-[10.5px] text-[var(--ytt-text-mute)]' },
    [sourceWrap, countWrap, langText, cacheWrap, h('span', { class: 'flex-1' }), diagBtn],
  );

  const element = h('div', { class: 'relative shrink-0 border-t border-[var(--ytt-border)]' }, [popover, footer]);

  let open = false;
  let failuresKey = '';

  const renderFailures = (failures: FailureRecord[]): void => {
    clear(popover);
    popover.appendChild(
      h('p', {
        class: 'mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ytt-text-mute)]',
        text: '抓取链路',
      }),
    );

    if (failures.length === 0) {
      popover.appendChild(h('p', { class: 'text-[11px] text-[var(--ytt-text-dim)]', text: '没有失败记录，第一层就命中了。' }));
      return;
    }

    const list = h('ul', { class: 'space-y-1' });
    for (const failure of failures) {
      const source = SOURCE_LABEL[failure.source as SourceName] ?? failure.source;
      list.appendChild(
        h('li', { class: 'flex items-start gap-2 text-[11px] leading-snug' }, [
          h('span', { class: 'w-[52px] shrink-0 text-[var(--ytt-text-mute)]', text: source }),
          h('span', { class: 'w-[104px] shrink-0 font-mono text-[10px] text-[var(--ytt-warn)]', text: failure.code }),
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
    update(state) {
      setText(sourceText, state.source ? SOURCE_LABEL[state.source] : '未抓取');
      sourceIcon.style.color = state.source ? 'var(--ytt-ok)' : '';
      setText(countText, String(state.lines.length));
      setText(langText, state.lang ?? '');
      show(cacheWrap, state.cached);
      show(langText, Boolean(state.lang));

      const failures = state.failures ?? [];
      const key = failures.map((f) => `${f.source}:${f.code}:${f.ms}`).join('|');
      if (key !== failuresKey) {
        failuresKey = key;
        renderFailures(failures);
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
