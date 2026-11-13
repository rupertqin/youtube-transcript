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
    class: 'truncate text-[15px] font-medium leading-[20px] text-[var(--ytt-text)]',
    text: 'Transcript Studio',
  });
  const subtitleEl = h('p', {
    class: 'truncate text-[12px] leading-[16px] text-[var(--ytt-text-mute)]',
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
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-[#ff0000] text-[13px] font-bold text-white',
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
    { class: 'flex h-[56px] shrink-0 items-center gap-3 border-b border-[var(--ytt-border)] px-4' },
    children,
  );

  return {
    element,
    setTitle: (text) => setText(titleEl, text),
    setSubtitle(text) {
      // 空串 = 没有话要说：整行隐藏，不留一条空行把标题顶偏
      setText(subtitleEl, text);
      subtitleEl.style.display = text.length > 0 ? '' : 'none';
    },
    setTheme(theme) {
      themeBtn.replaceChildren(icon(theme === 'light' ? 'sun' : theme === 'system' ? 'monitor' : 'moon'));
      themeBtn.title = `主题：${theme}`;
    },
  };
}
