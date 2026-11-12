import { h, setText } from './dom';
import { icon } from './icons';
import type { ThemePref } from './prefs';

const ICON_BTN =
  'inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--ytt-text-dim)] transition ' +
  'hover:bg-[var(--ytt-hover)] hover:text-[var(--ytt-text)] active:scale-95';

export interface HeaderOptions {
  onCycleTheme: () => void;
  onClose?: () => void;
}

export interface HeaderHandle {
  element: HTMLElement;
  setTitle(text: string): void;
  setSubtitle(text: string): void;
  setTheme(theme: ThemePref): void;
}

export function createHeader(options: HeaderOptions): HeaderHandle {
  const titleEl = h('p', {
    class: 'truncate text-[13px] font-semibold leading-tight text-[var(--ytt-text)]',
    text: 'Transcript Studio',
  });
  const subtitleEl = h('p', {
    class: 'truncate text-[10.5px] leading-tight text-[var(--ytt-text-mute)]',
    text: '等待抓取',
  });

  const themeBtn = h(
    'button',
    {
      class: ICON_BTN,
      attrs: { type: 'button', 'aria-label': '切换主题', title: '主题' },
      on: { click: () => options.onCycleTheme() },
    },
    [icon('moon')],
  );

  const children: (Node | null)[] = [
    h('div', {
      class:
        'flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-gradient-to-br from-[#ff4e45] to-[#ff7a45] text-[11px] font-bold text-white shadow-[0_2px_8px_rgba(255,78,69,0.35)]',
      text: 'T',
    }),
    h('div', { class: 'min-w-0 flex-1' }, [titleEl, subtitleEl]),
    themeBtn,
  ];

  if (options.onClose) {
    children.push(
      h(
        'button',
        {
          class: ICON_BTN,
          attrs: { type: 'button', 'aria-label': '关闭面板', title: '关闭' },
          on: { click: () => options.onClose?.() },
        },
        [icon('close')],
      ),
    );
  }

  const element = h(
    'header',
    { class: 'flex h-[52px] shrink-0 items-center gap-2 border-b border-[var(--ytt-border)] px-3' },
    children,
  );

  return {
    element,
    setTitle: (text) => setText(titleEl, text),
    setSubtitle: (text) => setText(subtitleEl, text),
    setTheme(theme) {
      themeBtn.replaceChildren(icon(theme === 'light' ? 'sun' : theme === 'system' ? 'monitor' : 'moon'));
      themeBtn.title = `主题：${theme}`;
    },
  };
}
