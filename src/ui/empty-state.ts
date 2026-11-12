import type { ErrorCode } from '../core/types';
import { h } from './dom';
import { icon } from './icons';
import { EMPTY_COPY, ERROR_COPY } from './labels';

export type EmptyKind = 'loading' | 'error' | 'nodata' | 'nomatch';

export interface EmptyOptions {
  kind: EmptyKind;
  code?: ErrorCode | null;
  detail?: string;
  needle?: string;
  /** 抓取阶段提示，例如「正在打开原生字幕面板」 */
  progress?: string | null;
  onRetry?: () => void;
  onClearSearch?: () => void;
}

function skeleton(label: string): HTMLElement {
  const rows: HTMLElement[] = [];
  const widths = [92, 76, 84, 64, 88];
  widths.forEach((width, index) => {
    const bar = h('div', {
      class: 'ytt-shimmer h-2.5 rounded-full bg-[var(--ytt-surface-2)]',
      style: { width: `${width}%`, 'animation-delay': `${index * 90}ms` },
    });
    rows.push(
      h('div', { class: 'flex items-start gap-3' }, [
        h('div', { class: 'ytt-shimmer mt-[3px] h-2.5 w-8 rounded-full bg-[var(--ytt-surface-2)]' }),
        bar,
      ]),
    );
  });

  return h('div', { class: 'flex flex-col gap-3 px-4 py-4' }, [
    h('div', { class: 'mb-1 flex items-center gap-2 text-[11px] font-medium tracking-wide text-[var(--ytt-text-mute)]' }, [
      (() => {
        const spinner = icon('spinner', 12);
        spinner.classList.add('animate-spin');
        return spinner;
      })(),
      h('span', { text: label }),
    ]),
    ...rows,
  ]);
}

/** 空态 / 错误态 / 无匹配：一律内联卡片，不弹原生对话框。 */
export function renderEmptyState(options: EmptyOptions): HTMLElement {
  if (options.kind === 'loading') return skeleton(options.progress || '正在抓取字幕…');

  if (options.kind === 'nomatch') {
    return h('div', { class: 'flex h-full flex-col items-center justify-center gap-2 px-6 text-center' }, [
      icon('searchX', 18),
      h('p', { class: 'text-[12.5px] text-[var(--ytt-text-dim)]', text: `没有匹配「${options.needle ?? ''}」的行` }),
      h(
        'button',
        {
          class:
            'rounded-lg border border-[var(--ytt-border-strong)] px-3 py-1 text-[11.5px] text-[var(--ytt-text)] transition hover:bg-[var(--ytt-hover)]',
          attrs: { type: 'button' },
          on: { click: () => options.onClearSearch?.() },
        },
        ['清空搜索'],
      ),
    ]);
  }

  const copy = options.code ? ERROR_COPY[options.code] : EMPTY_COPY;
  const isError = options.kind === 'error';
  const glyph = icon(isError ? 'alert' : 'searchX', 18);
  glyph.style.color = isError ? 'var(--ytt-err)' : 'var(--ytt-text-mute)';

  const children: (Node | null)[] = [
    h(
      'div',
      {
        class: 'flex h-11 w-11 items-center justify-center rounded-full',
        style: { background: 'var(--ytt-accent-soft)' },
      },
      [glyph],
    ),
    h('div', { class: 'space-y-1' }, [
      h('p', { class: 'text-[13px] font-semibold text-[var(--ytt-text)]', text: copy.title }),
      h('p', {
        class: 'max-w-[280px] text-[12px] leading-relaxed text-[var(--ytt-text-mute)]',
        text: copy.hint,
      }),
    ]),
  ];

  if (options.code) {
    const detail = options.detail ? ` · ${options.detail.slice(0, 42)}` : '';
    children.push(
      h('code', {
        class:
          'rounded-md border border-[var(--ytt-border)] px-2 py-1 text-[10px] tracking-wide text-[var(--ytt-text-mute)]',
        text: `${options.code}${detail}`,
      }),
    );
  }

  if (options.onRetry) {
    children.push(
      h(
        'button',
        {
          class:
            'mt-1 inline-flex items-center gap-1.5 rounded-lg border border-[var(--ytt-border-strong)] px-3 py-1.5 text-[12px] font-medium text-[var(--ytt-text)] transition hover:bg-[var(--ytt-hover)] active:scale-[0.98]',
          attrs: { type: 'button' },
          on: { click: () => options.onRetry?.() },
        },
        [icon('refresh', 12), '重试'],
      ),
    );
  }

  return h('div', { class: 'flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center' }, children);
}
