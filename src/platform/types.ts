import type { SiteClient } from '../core/site/types';

/**
 * UI 只依赖这个接口：
 *  - 扩展端 = 通过 chrome.runtime 远程订阅 content script 持有的权威状态
 *  - 油猴端 = 同一个 store 进程内直连
 *
 * 它就是站点契约里的 `SiteClient` —— 面板与挂载层（右栏 / 浮层 / 侧栏）共用同一份。
 */
export type TranscriptClient = SiteClient;

export type RuntimeKind = 'extension' | 'userscript';
