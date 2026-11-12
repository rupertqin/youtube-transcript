import { isPanelRequest } from '../src/platform/protocol';

export default defineBackground(() => {
  // 点工具栏图标 = 打开侧栏，这是 Chrome 认可的用户手势路径
  try {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => undefined);
  } catch {
    /* 旧版本 Chrome 没有 sidePanel API */
  }

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isPanelRequest(message)) return undefined;

    // 页面按钮点击 → 尝试打开侧栏；手势跨消息可能会丢，失败就由 content 回落到浮层
    if (message.type === 'OPEN_PANEL') {
      const windowId = sender.tab?.windowId;
      if (typeof windowId !== 'number') {
        sendResponse({ ok: false, reason: 'no-window' });
        return true;
      }
      chrome.sidePanel
        .open({ windowId })
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => sendResponse({ ok: false, reason: String(error) }));
      return true;
    }

    return undefined;
  });
});
