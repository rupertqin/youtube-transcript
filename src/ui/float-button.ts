import { createEntryButton } from '../core/dom/button';

export const FLOAT_BUTTON_ID = 'ytt-float-btn';

export interface FloatButtonOptions {
  doc: Document;
  label: string;
  onClick: () => void;
}

/**
 * 浮层入口胶囊。
 *
 * 与 YouTube 的 masthead 入口同一副皮囊（`createEntryButton`），
 * 只是位置固定在右下角 —— B 站没有「右栏」这个挂载点。
 */
export function createFloatButton(options: FloatButtonOptions): HTMLButtonElement {
  const button = createEntryButton({
    doc: options.doc,
    label: options.label,
    id: FLOAT_BUTTON_ID,
    title: '打开字幕面板',
    onClick: () => options.onClick(),
  });
  // 浮在视频上：阴影要更重一点，否则在亮色画面里边界会糊掉
  button.style.height = '38px';
  button.style.boxShadow = '0 10px 26px -10px rgba(255,78,69,.75)';
  button.style.pointerEvents = 'auto';
  return button;
}
