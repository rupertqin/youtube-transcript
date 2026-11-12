import { BRIDGE_CHANNEL } from './protocol';

type Handler = (payload: unknown) => unknown | Promise<unknown>;

interface Envelope {
  channel: string;
  kind: 'req' | 'res' | 'evt';
  id: string;
  type: string;
  payload?: unknown;
  ok?: boolean;
  error?: string;
}

export interface BridgeEndpoint {
  handle(type: string, fn: Handler): void;
  on(type: string, fn: (payload: unknown) => void): () => void;
  request<T>(type: string, payload?: unknown, timeoutMs?: number): Promise<T>;
  emit(type: string, payload?: unknown): void;
  dispose(): void;
}

/**
 * MAIN world 与 ISOLATED world 之间的最小 RPC（window.postMessage）。
 * 只认本通道 + 同源 source，避免和其他扩展/页脚脚本串台。
 */
export function createBridgeEndpoint(win: Window): BridgeEndpoint {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  let counter = 0;

  const post = (envelope: Envelope) => {
    win.postMessage(envelope, win.location.origin === 'null' ? '*' : win.location.origin);
  };

  const dispatchEvent = (type: string, payload: unknown) => {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (error) {
        console.error('[ytt] bridge listener failed', error);
      }
    }
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== win) return;
    const data = event.data as Envelope | undefined;
    if (!data || data.channel !== BRIDGE_CHANNEL) return;

    if (data.kind === 'req') {
      const handler = handlers.get(data.type);
      if (!handler) return; // 没有处理器就不应答，让对面超时走兜底
      Promise.resolve()
        .then(() => handler(data.payload))
        .then((result) => {
          post({ channel: BRIDGE_CHANNEL, kind: 'res', id: data.id, type: data.type, ok: true, payload: result });
        })
        .catch((error: unknown) => {
          post({
            channel: BRIDGE_CHANNEL,
            kind: 'res',
            id: data.id,
            type: data.type,
            ok: false,
            error: String(error),
          });
        });
      return;
    }

    if (data.kind === 'res') {
      const waiter = pending.get(data.id);
      if (!waiter) return;
      pending.delete(data.id);
      clearTimeout(waiter.timer);
      if (data.ok) waiter.resolve(data.payload);
      else waiter.reject(new Error(data.error ?? 'bridge error'));
      return;
    }

    if (data.kind === 'evt') dispatchEvent(data.type, data.payload);
  };

  win.addEventListener('message', onMessage);

  const endpoint: BridgeEndpoint = {
    handle(type, fn) {
      handlers.set(type, fn);
    },
    on(type, fn) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
      return () => set.delete(fn);
    },
    request<T>(type: string, payload?: unknown, timeoutMs = 8000) {
      counter += 1;
      const id = `r${counter}`;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`bridge timeout: ${type}`));
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        post({ channel: BRIDGE_CHANNEL, kind: 'req', id, type, payload });
      });
    },
    emit(type, payload) {
      post({ channel: BRIDGE_CHANNEL, kind: 'evt', id: '', type, payload });
    },
    dispose() {
      win.removeEventListener('message', onMessage);
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('bridge disposed'));
      }
      pending.clear();
      handlers.clear();
      listeners.clear();
    },
  };

  return endpoint;
}
