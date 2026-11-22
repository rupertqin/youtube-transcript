import { createStore, emptyPanelState } from '../core/store';
import type { PanelState } from '../core/types';
import { isPanelBroadcast, RUNTIME_TAG, type PanelRequest } from './protocol';
import type { TranscriptClient } from './types';

/**
 * Chrome 扩展 Side Panel 专属客户端：状态在 content script 里，这里只是一个远程视图。
 * 侧栏文档拿不到页面 video，所有动作（load/seek）都必须转成消息。
 */
export function createRemoteClient(): TranscriptClient {
  const store = createStore<PanelState>(emptyPanelState());
  let tabId: number | null = null;

  const resolveTab = async (): Promise<number | null> => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.id ?? null;
    } catch {
      return null;
    }
  };

  const send = async (message: PanelRequest): Promise<unknown> => {
    if (tabId === null) tabId = await resolveTab();
    if (tabId === null) return null;
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      return null;
    }
  };

  const requestState = async (): Promise<void> => {
    const response = await send({ tag: RUNTIME_TAG, type: 'STATE_REQUEST' });
    if (response && typeof response === 'object' && 'status' in (response as PanelState)) {
      store.setState(response as PanelState);
      return;
    }
    store.setState({
      ...emptyPanelState(''),
      status: 'error',
      error: { code: 'NO_CAPTION_TRACK', detail: '当前标签页不是 YouTube 视频页' },
    });
  };

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isPanelBroadcast(message)) return;
    const payload = message.payload as PanelState | null;
    if (payload && typeof payload === 'object' && 'status' in payload) store.setState(payload);
  });

  chrome.tabs.onActivated.addListener(() => {
    tabId = null;
    void requestState();
  });

  chrome.tabs.onUpdated.addListener((updatedId, info) => {
    if (!info.url && info.status !== 'complete') return;
    if (tabId !== null && updatedId !== tabId) return;
    void requestState();
  });

  void requestState();

  return {
    getState: () => store.getState(),
    subscribe: (listener) => store.subscribe(listener),
    load: async (force) => {
      await send({ tag: RUNTIME_TAG, type: 'LOAD', force: Boolean(force) });
    },
    seek: (seconds) => {
      void send({ tag: RUNTIME_TAG, type: 'SEEK', seconds });
    },
  };
}
