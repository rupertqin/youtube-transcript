import { installShadowCapture } from '../src/core/dom/shadow';
import { fetchGetTranscript } from '../src/core/harvest/get-transcript';
import { installTimedTextHook } from '../src/core/harvest/intercept';
import { linesFromCapture } from '../src/core/harvest/sources';
import { runRemoteSources } from '../src/core/harvest/sources';
import { readStoryboardSpec } from '../src/core/harvest/player';
import { langMatches } from '../src/core/langs';
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
  installShadowCapture(window);
    const hook = installTimedTextHook(window);
    const endpoint = createBridgeEndpoint(window);

    endpoint.handle('PING', () => ({ ready: true, hookInstalledAt: hook.installedAt }));

    // 章节截图用的雪碧图规格：playerResponse 只在 MAIN world 存在
    endpoint.handle('STORYBOARD', () => readStoryboardSpec(window));

    // 用户手动打开原生 Transcript 面板时，YouTube 会自己请求 get_transcript；
    // 立刻通知 content script 重新加载，不需要用户再点一次「重试」
    hook.onCapture((capture) => {
      endpoint.emit('CAPTURE', {
        kind: capture.kind,
        videoId: capture.videoId,
        at: capture.at,
      });
    });

    endpoint.handle('GET_TRANSCRIPT', async (raw) => {
      const payload = raw as { videoId?: string; langs?: string[] } | null;
      const videoId = payload?.videoId;
      if (!videoId) return null;

      const controller = new AbortController();
      // 主路径必须快：结构化源排在最前，卡住会拖慢整条链
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const outcome = await fetchGetTranscript({
          win: window,
          fetchFn: window.fetch.bind(window),
          videoId,
          langs: payload?.langs ?? ['zh-Hans', 'zh', 'en'],
          signal: controller.signal,
          timeoutMs: 6_000,
          maxAttempts: 10,
        });
        if (!outcome) return null;
        return {
          lines: outcome.lines,
          source: 'innertube',
          track: { baseUrl: `get_transcript:${outcome.params}`, languageCode: outcome.lang },
          showTimestamps: true,
          failures: [],
          complete: true,
        };
      } finally {
        clearTimeout(timer);
      }
    });

    endpoint.handle('HARVEST_REMOTE', async (raw) => {
      const payload = raw as { videoId?: string; langs?: string[]; tlang?: string | null } | null;
      const videoId = payload?.videoId;
      if (!videoId) return null;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 22000);
      const ctx: HarvestContext = {
        videoId,
        langs: payload?.langs ?? ['zh-Hans', 'zh', 'en'],
        tlang: payload?.tlang ?? null,
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
      const payload = raw as { videoId?: string; timeoutMs?: number; tlang?: string | null } | null;
      const videoId = payload?.videoId;
      if (!videoId) return null;

      const capture = await hook.waitFor(videoId, payload?.timeoutMs ?? 2500);
      if (!capture) return null;

      // 要的是另一种语言，但捕获到的是原声轨道：这一层给不了翻译结果，
      // 放行就会「切成中文显示英文」且状态是 ready，用户看不出问题。
      const tlang = payload?.tlang ?? null;
      if (tlang && !langMatches(capture.lang, tlang)) return null;

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
