import type { Store } from '../core/store';
import type { PanelState } from '../core/types';
import type { TranscriptClient } from './types';

/**
 * 两端共用的同进程客户端（不是油猴专属）：油猴脚本与扩展 content script 都用它。
 * 状态就在本进程里，直接读写；扩展 Side Panel 进程外才需要 `client.sidepanel-chrome.ts`。
 */
export function createLocalClient(options: {
  store: Store<PanelState>;
  load: (force?: boolean) => Promise<void>;
  seek: (seconds: number) => void;
}): TranscriptClient {
  return {
    getState: () => options.store.getState(),
    subscribe: (listener) => options.store.subscribe(listener),
    load: (force) => options.load(Boolean(force)),
    seek: (seconds) => options.seek(seconds),
  };
}
