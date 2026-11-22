import { sleep } from '../src/core/dom/wait';
import { log } from '../src/core/log';
import { createSite } from '../src/core/site/create';
import type { BiliPageSnapshot } from '../src/core/site/bilibili/page-state';
import { createBridgeEndpoint } from '../src/platform/bridge.chrome-main-world';
import { createLocalClient } from '../src/platform/client.in-process';
import { isPanelRequest, RUNTIME_TAG } from '../src/platform/protocol';
import { createSession } from '../src/platform/session';
import { getPrefs } from '../src/ui/prefs';
import panelCss from '../src/ui/styles.css?inline';

/**
 * 内容脚本入口（ISOLATED world）。
 *
 * 这里刻意不含任何站点逻辑：`createSite` 按 host 选适配器，会话层与面板
 * 都只认适配器接口。加一个站点 = 加一个 adapter，这个文件不用动。
 */
export default defineContentScript({
  matches: ['https://www.youtube.com/*', 'https://www.bilibili.com/*'],
  runAt: 'document_start',
  async main(ctx) {
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

    const site = createSite({
      win: window,
      doc: document,
      log,
      bridge,
      ensureBridge,
      // 每次抓取现读偏好：切语言后下一次 load 立即生效
      readChoice: () => getPrefs().lang,
      autoSwitchTrack: () => getPrefs().autoSwitchTrack,
      // B 站首屏状态在页面世界：isolated 读不到，必须过 MAIN world 桥
      readPageState: async () => {
        if (!(await ensureBridge())) return null;
        try {
          return await bridge.request<BiliPageSnapshot | null>('BILI_STATE', null, 1500);
        } catch {
          return null;
        }
      },
    });
    // 不认识的页面：一个按钮都不注入
    if (!site) return;

    const session = createSession({ win: window, site });
    const client = createLocalClient({
      store: session.store,
      load: session.load,
      seek: session.seek,
    });

    // 挂载点由站点决定：YouTube = 右栏卡片 + masthead 按钮，B 站 = 右下浮层
    const panel = site.mount({
      doc: document,
      css: panelCss,
      client,
      currentVideoId: () => site.videoIdOf(window.location),
    });

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

    // MAIN world 的钩子把「站点自己发出了字幕请求」转发过来 → 自动重载。
    // 只有 YouTube 的 hook 会发这个事件；B 站没有对应通路。
    bridge.on('CAPTURE', (raw) => {
      if (site.id !== 'youtube') return;
      const payload = raw as { kind?: string; videoId?: string | null } | null;
      if (payload?.kind !== 'get_transcript') return;
      if (payload.videoId && payload.videoId !== site.videoIdOf(window.location)) return;
      if (session.store.getState().status !== 'error') return;
      void session.load(true);
    });

    // 先把面板挂上（document_start 时页面容器可能还没渲染，内部会自动重试）
    try {
      panel.ensureMounted();
    } catch (error) {
      log({ code: 'UNKNOWN', source: 'host', detail: `panel mount failed: ${String(error)}` });
    }
    session.sync();
    // 定时对账：不依赖 locationchange，漏事件也能在 500ms 内跟上切页
    session.start();

    ctx.addEventListener(window, 'wxt:locationchange', () => {
      // 每一步独立隔离：挂载失败不能吃掉同步
      try {
        panel.ensureMounted();
      } catch (error) {
        log({ code: 'UNKNOWN', source: 'host', detail: `panel remount failed: ${String(error)}` });
      }
      session.sync();
    });

    ctx.onInvalidated(() => {
      session.dispose();
      panel.destroy();
    });
  },
});
