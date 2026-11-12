import type { PanelState } from '../core/types';

/**
 * UI 只依赖这个接口：
 *  - 扩展端 = 通过 chrome.runtime 远程订阅 content script 持有的权威状态
 *  - 油猴端 = 同一个 store 进程内直连
 */
export interface TranscriptClient {
  getState(): PanelState;
  subscribe(listener: (state: PanelState) => void): () => void;
  load(force?: boolean): Promise<void>;
  seek(seconds: number): void;
}

export type RuntimeKind = 'extension' | 'userscript';
