import { installTimedTextHook } from '../src/core/harvest/intercept';
import { linesFromCapture } from '../src/core/harvest/sources';
import { runRemoteSources } from '../src/core/harvest/sources';
import { log } from '../src/core/log';
import type { HarvestContext } from '../src/core/types';
import { createBridgeEndpoint } from '../src/platform/bridge';

/**
 * MAIN world：唯一能看到页面 JS 上下文的地方。
 * 负责 ① 被动拦截（document_start 就装 hook）、② playerResponse、④ InnerTube。
 * 抓到的数据通过 postMessage 交给 ISOLATED 的 content script。
 */
export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const hook = installTimedTextHook(window);
    const endpoint = createBridgeEndpoint(window);

    endpoint.handle('PING', () => ({ ready: true, hookInstalledAt: hook.installedAt }));

    endpoint.handle('HARVEST_REMOTE', async (raw) => {
      const payload = raw as { videoId?: string; langs?: string[] } | null;
      const videoId = payload?.videoId;
      if (!videoId) return null;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 22000);
      const ctx: HarvestContext = {
        videoId,
        langs: payload?.langs ?? ['zh-Hans', 'zh', 'en'],
        signal: controller.signal,
        log,
      };

      try {
        const outcome = await runRemoteSources({ win: window, ctx });
        if (!outcome || outcome.lines.length === 0) return null;
        return {
          lines: outcome.lines,
          source: outcome.source,
          track: outcome.track,
          showTimestamps: outcome.showTimestamps,
          failures: outcome.failures ?? [],
        };
      } finally {
        clearTimeout(timer);
      }
    });

    endpoint.handle('WAIT_TIMEDTEXT', async (raw) => {
      const payload = raw as { videoId?: string; timeoutMs?: number } | null;
      const videoId = payload?.videoId;
      if (!videoId) return null;

      const capture = await hook.waitFor(videoId, payload?.timeoutMs ?? 2500);
      if (!capture) return null;

      const lines = linesFromCapture(capture);
      if (lines.length === 0) return null;

      return {
        lines,
        source: 'intercept',
        showTimestamps: true,
        track: capture.lang ? { baseUrl: capture.url, languageCode: capture.lang } : undefined,
        failures: [],
      };
    });
  },
});
