import type { Store } from '../core/store';
import type { PanelState } from '../core/types';
import type { TranscriptClient } from './types';

/** 油猴端 / content script 端：状态就在本进程里，直接读写。 */
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
