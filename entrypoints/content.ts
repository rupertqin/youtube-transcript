import { ensureEntryButton, removeEntryButton } from '../src/core/dom/button';
import { pickPanel } from '../src/core/dom/panel';
import { createPanelSession } from '../src/core/dom/panel-session';
import { scrapePanel } from '../src/core/dom/scrape';
import { sleep } from '../src/core/dom/wait';
import { harvestTranscript } from '../src/core/harvest/chain';
import { readTitle, readVideoId } from '../src/core/harvest/player';
import { defaultLangs } from '../src/core/langs';
import { log } from '../src/core/log';
import type { SourceOutcome } from '../src/core/types';
import { createBridgeEndpoint } from '../src/platform/bridge';
import { createLocalClient } from '../src/platform/local-client';
import { isPanelRequest, RUNTIME_TAG } from '../src/platform/protocol';
import { createSession } from '../src/platform/session';
import { createOverlay } from '../src/ui/overlay';
import panelCss from '../src/ui/styles.css?inline';

interface RemotePayload {
  lines: { start: number; dur: number; text: string }[];
  source: 'player' | 'innertube' | 'intercept';
  track?: SourceOutcome['track'];
  showTimestamps: boolean;
  failures?: SourceOutcome['failures'];
}

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  runAt: 'document_start',
  async main(ctx) {
    const LANGS = defaultLangs();
    const panelSession = createPanelSession(document);
    const bridge = createBridgeEndpoint(window);

    let bridgeReady: Promise<boolean> | null = null;
    const ensureBridge = (): Promise<boolean> => {
      bridgeReady ??= (async () => {
        for (let attempt = 0; attempt < 15; attempt += 1) {
          try {
            await bridge.request('PING', null, 400);
            return true;
          } catch {
            await sleep(200);
          }
        }
        log({ code: 'NETWORK_ERROR', source: 'host', detail: 'MAIN world bridge unreachable' });
        return false;
      })();
      return bridgeReady;
    };

    const toOutcome = (payload: RemotePayload | null): SourceOutcome | null => {
      if (!payload || !Array.isArray(payload.lines) || payload.lines.length === 0) return null;
      return {
        lines: payload.lines,
        source: payload.source,
        track: payload.track,
        showTimestamps: payload.showTimestamps,
        failures: payload.failures ?? [],
      };
    };

    const session = createSession({
      win: window,
      hooks: {
        title: () => readTitle(window),
        harvest: async (videoId, signal, onStage) => {
          // bridge 没起来（旧标签页、注入失败）时直接退化到 DOM 抓取，别白等超时
          const bridgeUp = await ensureBridge();
          return harvestTranscript({
            signal,
            log,
            onStage,
            remote: bridgeUp
              ? async () => {
                  const payload = await bridge.request<RemotePayload | null>(
                    'HARVEST_REMOTE',
                    { videoId, langs: LANGS },
                    25000,
                  );
                  return toOutcome(payload);
                }
              : undefined,
            intercept: bridgeUp
              ? async (timeoutMs) => {
                  const payload = await bridge.request<RemotePayload | null>(
                    'WAIT_TIMEDTEXT',
                    { videoId, timeoutMs },
                    timeoutMs + 3000,
                  );
                  return toOutcome(payload);
                }
              : undefined,
            openPanel: panelSession.openPanel,
            closePanel: panelSession.closePanel,
            dom: async (panel) => {
              const target = (panel as Element | null) ?? pickPanel(document);
              if (!target) return null;
              const scraped = await scrapePanel(target);
              if (scraped.lines.length === 0) return null;
              return {
                lines: scraped.lines,
                source: 'dom',
                showTimestamps: scraped.showTimestamps,
              };
            },
          });
        },
      },
    });

    const client = createLocalClient({
      store: session.store,
      load: session.load,
      seek: session.seek,
    });

    // content script 只能是 IIFE（Chrome 不支持 ESM content script），所以
    // 动态 import 会被内联，无法靠代码分割减到 content.js 的体积 —— 见 README「体积」一节。
    const overlay = createOverlay({ doc: document, css: panelCss, client });

    /* ---- 与 Side Panel 通信 ---- */
    let lastBroadcast = 0;
    session.store.subscribe((state) => {
      const now = Date.now();
      if (now - lastBroadcast < 160) return;
      lastBroadcast = now;
      try {
        const result = chrome.runtime.sendMessage({ tag: RUNTIME_TAG, type: 'STATE', payload: state });
        if (result && typeof result.catch === 'function') result.catch(() => undefined);
      } catch {
        /* 没有接收方是正常情况 */
      }
    });

    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (!isPanelRequest(message)) return undefined;
      if (message.type === 'STATE_REQUEST') {
        sendResponse(session.store.getState());
        return true;
      }
      if (message.type === 'LOAD') {
        void session.load(message.force);
        sendResponse({ ok: true });
        return true;
      }
      if (message.type === 'SEEK') {
        session.seek(message.seconds);
        sendResponse({ ok: true });
        return true;
      }
      return undefined;
    });

    /* ---- 页面入口 ---- */
    const openSidePanel = async (): Promise<boolean> => {
      try {
        const result = (await chrome.runtime.sendMessage({ tag: RUNTIME_TAG, type: 'OPEN_PANEL' })) as
          | { ok?: boolean }
          | undefined;
        return Boolean(result?.ok);
      } catch {
        return false;
      }
    };

    const refreshButton = async (): Promise<void> => {
      if (!readVideoId(window)) {
        removeEntryButton(document);
        return;
      }
      await ensureEntryButton({
        doc: document,
        label: 'Transcript',
        title: '打开字幕面板',
        onClick: async () => {
          const opened = await openSidePanel();
          if (!opened) overlay.toggle();
        },
      });
    };

    session.sync();
    void refreshButton();

    ctx.addEventListener(window, 'wxt:locationchange', () => {
      overlay.hide();
      session.sync();
      void refreshButton();
    });

    ctx.onInvalidated(() => overlay.destroy());
  },
});
