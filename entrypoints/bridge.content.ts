import { installShadowCapture } from '../src/core/dom/shadow';
import { fetchPanelTranscript } from '../src/core/harvest/get-panel';
import { installTimedTextHook } from '../src/core/harvest/intercept';
import { runRemoteSources } from '../src/core/harvest/sources';
import { interceptWithAutoSwitch } from '../src/core/harvest/player-track';
import {
  readAudioTrackLang,
  readAvailableLangs,
  readOwnCaptionLangs,
  readPlayerResponse,
  readStoryboardSpec,
} from '../src/core/harvest/player';
import { readBiliPageState } from '../src/core/site/bilibili/page-state';
import { log } from '../src/core/log';
import type { ErrorCode, HarvestContext } from '../src/core/types';
import { createBridgeEndpoint } from '../src/platform/bridge.chrome-main-world';

/**
 * MAIN world：唯一能看到页面 JS 上下文的地方。
 * 负责 ① 被动拦截（document_start 就装 hook）、② playerResponse、④ InnerTube。
 * 抓到的数据通过 postMessage 交给 ISOLATED 的 content script。
 */
export default defineContentScript({
  matches: ['https://www.youtube.com/*', 'https://www.bilibili.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const endpoint = createBridgeEndpoint(window);

    // B 站只需要把页面世界的 __INITIAL_STATE__ 摘要交给 content script
    // （isolated world 读不到页面对象）。不装 timedtext hook —— 那是 YouTube 的通路，
    // 在 B 站装它只会白白 patch fetch/XHR。
    if (location.hostname.endsWith('bilibili.com')) {
      endpoint.handle('PING', () => ({ ready: true }));
      endpoint.handle('BILI_STATE', () => readBiliPageState(window));
      return;
    }

    installShadowCapture(window);
    const hook = installTimedTextHook(window);

    endpoint.handle('PING', () => ({ ready: true, hookInstalledAt: hook.installedAt }));

    // 章节截图用的雪碧图规格：playerResponse 只在 MAIN world 存在
    endpoint.handle('STORYBOARD', () => readStoryboardSpec(window));

    /**
     * 这条视频有哪些字幕语言。
     *
     * ISOLATED world 读不到 `ytInitialPlayerResponse`（页面 JS 全局），直接读永远是
     * 空数组 —— 语言按钮因此从不出现，`pickUsableChoice()` 也永远不知道能不能降级。
     * 过桥是唯一可靠的办法。
     */
    endpoint.handle('READ_LANGS', (raw) => {
      const payload = raw as { videoId?: string } | null;
      const videoId = payload?.videoId ?? '';
      const response = readPlayerResponse(window);
      return {
        // 自证归属：切页瞬间播放器可能还挂着上一个视频的响应
        videoId: response?.videoDetails?.videoId ?? null,
        langs: readAvailableLangs(window, videoId || undefined),
        // 「同音频」优先顺序：默认音轨自己的字幕 → 音轨语言
        own: readOwnCaptionLangs(window, videoId || undefined),
        defaultLang: readAudioTrackLang(window, videoId || undefined),
      };
    });

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
      const started = Date.now();
      try {
        // 就直接问 get_panel：2026 面板唯一的数据源，一次请求拿全部分段
        const outcome = await fetchPanelTranscript({
          win: window,
          fetchFn: window.fetch.bind(window),
          videoId,
          signal: controller.signal,
          timeoutMs: 6_000,
        });
        return {
          lines: outcome.lines,
          source: 'innertube' as const,
          track: outcome.lang
            ? { baseUrl: `structured:${videoId}`, languageCode: outcome.lang }
            : undefined,
          showTimestamps: true,
          failures: [],
          complete: true,
        };
      } catch (error) {
        // 失败也把分类带回去：RPC 的 reject 只剩 message，code 一丢，
        // ISOLATED 侧就会把「200 但 0 段」误记成 NETWORK_ERROR。
        const code = (error as { code?: ErrorCode }).code ?? 'UNKNOWN';
        return {
          lines: [],
          source: 'innertube' as const,
          showTimestamps: true,
          failures: [
            {
              source: 'innertube' as const,
              code,
              ms: Date.now() - started,
              detail: (error as Error)?.message ?? String(error),
            },
          ],
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
        if (!outcome) return null;
        // 0 行也要回传：每一层的失败码（POT 空 body / 无轨道）是诊断里唯一的信息源
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
