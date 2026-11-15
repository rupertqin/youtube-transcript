import { installShadowCapture } from '../src/core/dom/shadow';
import { fetchPanelTranscript } from '../src/core/harvest/get-panel';
import { installTimedTextHook } from '../src/core/harvest/intercept';
import { runRemoteSources } from '../src/core/harvest/sources';
import { interceptWithAutoSwitch } from '../src/core/harvest/player-track';
import { readPlayerResponse, readStoryboardSpec } from '../src/core/harvest/player';
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
        // 就直接问 get_panel：2026 面板唯一的数据源，一次请求拿全部分段
        const outcome = await fetchPanelTranscript({
          win: window,
          fetchFn: window.fetch.bind(window),
          videoId,
          signal: controller.signal,
          timeoutMs: 6_000,
        });
        if (!outcome) return null;
        return {
          lines: outcome.lines,
          source: 'innertube',
          track: outcome.lang
            ? { baseUrl: `structured:${videoId}`, languageCode: outcome.lang }
            : undefined,
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
      const payload = raw as {
        videoId?: string;
        timeoutMs?: number;
        tlang?: string | null;
        langs?: string[];
        autoSwitch?: boolean;
      } | null;
      const videoId = payload?.videoId;
      if (!videoId) return null;

      // 和油猴端走同一套逻辑：按目标语言挑捕获、语言不符就等新的一条；
      // 还没有就问播放器要（切一次 CC 轨道 → 截带 POT 的 timedtext → 切回来）。
      return interceptWithAutoSwitch({
        win: window,
        hook,
        ctx: {
          videoId,
          langs: payload?.langs ?? [],
          tlang: payload?.tlang ?? null,
          defaultLang: readPlayerResponse(window)?.videoDetails?.defaultAudioLanguage ?? null,
          signal: new AbortController().signal,
          log,
        },
        timeoutMs: payload?.timeoutMs ?? 2500,
        enabled: Boolean(payload?.autoSwitch),
      });
    });
  },
});
