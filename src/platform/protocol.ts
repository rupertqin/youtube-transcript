/** 窄消息协议：只有这几种，避免两端各自发明字段。 */

export const BRIDGE_CHANNEL = 'ytt-bridge-v1';

/** MAIN world bridge 支持的方法 */
export type BridgeRequest =
  | { type: 'PING' }
  | { type: 'HARVEST_REMOTE'; videoId: string; langs: string[]; tlang?: string | null }
  | { type: 'WAIT_TIMEDTEXT'; videoId: string; timeoutMs: number; tlang?: string | null }
  | { type: 'GET_TRANSCRIPT'; videoId: string; langs: string[] }
  /** storyboard 规格只在 MAIN world 读得到（playerResponse 在页面上下文） */
  | { type: 'STORYBOARD' };

export interface BridgeRemotePayload {
  lines: { start: number; dur: number; text: string }[];
  source: 'player' | 'innertube';
  track?: { baseUrl: string; languageCode: string; kind?: string; name?: string };
  showTimestamps: boolean;
  failures: { source: string; code: string; ms: number; detail?: string }[];
}

/** content script ↔ side panel（chrome.runtime） */
export const RUNTIME_TAG = 'ytt';

export type PanelRequest =
  | { tag: typeof RUNTIME_TAG; type: 'STATE_REQUEST' }
  | { tag: typeof RUNTIME_TAG; type: 'LOAD'; force?: boolean }
  | { tag: typeof RUNTIME_TAG; type: 'SEEK'; seconds: number }
  | { tag: typeof RUNTIME_TAG; type: 'OPEN_PANEL' };

export type PanelBroadcast = {
  tag: typeof RUNTIME_TAG;
  type: 'STATE';
  payload: unknown;
};

export function isPanelRequest(value: unknown): value is PanelRequest {
  return Boolean(value) && typeof value === 'object' && (value as { tag?: string }).tag === RUNTIME_TAG;
}

export function isPanelBroadcast(value: unknown): value is PanelBroadcast {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as { tag?: string }).tag === RUNTIME_TAG &&
    (value as { type?: string }).type === 'STATE'
  );
}
