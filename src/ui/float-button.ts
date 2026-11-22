import { createEntryButton } from '../core/dom/button';

/** 历史 id，保留它避免已有用户样式失效；按钮现在挂在 B 站 header 上。 */
export const BILI_ENTRY_BUTTON_ID = 'ytt-float-btn';

export interface FloatButtonOptions {
  doc: Document;
  label: string;
  onClick: () => void;
}

/**
 * B 站入口胶囊，与 YouTube masthead 入口同一副皮囊（`createEntryButton`）。
 *
 * 位置由调用方决定：现在放进 B 站顶部导航 `<ul class="right-entry">`，
 * 作为投稿按钮左侧的同级 `<li>`；toggle 的是右栏卡片，不是浮层面板。
 */
export function createFloatButton(options: FloatButtonOptions): HTMLButtonElement {
  const button = createEntryButton({
    doc: options.doc,
    label: options.label,
    id: BILI_ENTRY_BUTTON_ID,
    title: '在右栏打开字幕',
    onClick: () => options.onClick(),
  });
  button.style.height = '34px';
  button.style.pointerEvents = 'auto';
  return button;
}
