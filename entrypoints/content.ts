import { ensureEntryButton, flashEntryButton, removeEntryButton } from '../src/core/dom/button';
import { readDomPreview, readRenderedTranscript } from '../src/core/dom/native-panel';
import { closeTranscriptPanelIfOurs, ensureFreshTranscriptRequest } from '../src/core/dom/panel';
import { sleep } from '../src/core/dom/wait';
import { harvestTranscript } from '../src/core/harvest/chain';
import {
  hasNativeTrackFor,
  readAvailableLangs,
  readTitleFor,
  readVideoId,
} from '../src/core/harvest/player';
import { langMatches, pickUsableChoice, resolveLangPlan } from '../src/core/langs';
import { log } from '../src/core/log';
import type { SourceOutcome } from '../src/core/types';
import { createBridgeEndpoint } from '../src/platform/bridge';
import { createLocalClient } from '../src/platform/local-client';
import { isPanelRequest, RUNTIME_TAG } from '../src/platform/protocol';
import { createSession } from '../src/platform/session';
import { getPrefs } from '../src/ui/prefs';
import { createSidebarPanel } from '../src/ui/sidebar';
import panelCss from '../src/ui/styles.css?inline';

interface RemotePayload {
  lines: { start: number; dur: number; text: string }[];
  source: 'player' | 'innertube' | 'intercept';
  track?: SourceOutcome['track'];
  showTimestamps: boolean;
  failures?: SourceOutcome['failures'];
  complete?: boolean;
}

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  runAt: 'document_start',
  async main(ctx) {
    // 每次抓取现读偏好：切语言后下一次 load 立即生效。
    // 视频给不了所选语言时按「同音频」处理 —— 和按钮的禁用状态保持一致。
    const langPlan = () => {
      const available = readAvailableLangs(window, readVideoId(window) ?? undefined);
      return resolveLangPlan(pickUsableChoice(getPrefs().lang, available));
    };
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
        complete: payload.complete !== false,
      };
    };

    const session = createSession({
      win: window,
      hooks: {
        // 标题按 videoId 取，避免「新字幕配旧标题」
        title: (videoId) => readTitleFor(window, videoId),
        langPlan,
        // playerResponse 只在 MAIN world，章节截图规格必须过桥
        storyboard: async () => {
          if (!(await ensureBridge())) return null;
          try {
            return await bridge.request<string | null>('STORYBOARD', null, 2500);
          } catch {
            return null;
          }
        },
        harvest: async (videoId, signal, onStage, options) => {
          // bridge 没起来（旧标签页、注入失败）时直接退化到 DOM 抓取，别白等超时
          const bridgeUp = await ensureBridge();
          const plan = langPlan();
          // 没有目标语言的原生轨道时，拦截层 / DOM 层只能给原文 —— 让远程先上
          const needsTranslation = Boolean(plan.tlang) && !hasNativeTrackFor(window, plan.tlang!);

          const domOptions = () => ({
            videoId,
            skipSnapshot: options?.staleRisk,
            avoidSignature: options?.avoid ?? null,
          });
          // 页面已渲染的字幕：先当临时预览，所有完整源都失败时再当兜底（不进缓存）
          const readRendered = (): SourceOutcome | null => {
            const result = readDomPreview(document, domOptions());
            if (result.lines.length === 0) return null;
            return {
              lines: result.lines,
              source: 'dom',
              showTimestamps: result.showTimestamps,
              complete: false,
            };
          };
          // 兜底要读全：在面板自己的滚动容器里从头滚到底，攒齐所有行
          const readRenderedFull = async (): Promise<SourceOutcome | null> => {
            const result = await readRenderedTranscript(document, domOptions());
            if (result.lines.length === 0) return null;
            return {
              lines: result.lines,
              source: 'dom',
              showTimestamps: result.showTimestamps,
              complete: false,
            };
          };
          return harvestTranscript({
            signal,
            log,
            onStage,
            preferRemote: needsTranslation,
            remote: bridgeUp
              ? async () => {
                  const payload = await bridge.request<RemotePayload | null>(
                    'HARVEST_REMOTE',
                    { videoId, langs: langPlan().langs, tlang: langPlan().tlang },
                    25000,
                  );
                  return toOutcome(payload);
                }
              : undefined,
            cachedIntercept: bridgeUp
              ? async () => {
                  const payload = await bridge.request<RemotePayload | null>(
                    'WAIT_TIMEDTEXT',
                    {
                      videoId,
                      timeoutMs: 0,
                      tlang: langPlan().tlang,
                      langs: langPlan().langs,
                    },
                    3000,
                  );
                  return toOutcome(payload);
                }
              : undefined,
            intercept: bridgeUp
              ? async (timeoutMs) => {
                  // 同油猴端：CC 关着时播放器不发 timedtext，
                  // 但原生面板的 get_transcript 与 CC 无关 —— 面板已开着时收起再点开，
                  // 逼它重新请求（POST 不会被缓存），截到的是完整响应。
                  //
                  // 指定了产出语言时不点：面板永远只给默认轨，点开只会闪一下然后
                  // 被语言检查拒掉。这时该等的是用户切 CC 语言（timedtext 捕获）。
                  if (!langPlan().tlang) {
                    await ensureFreshTranscriptRequest(document, { timeoutMs: 1_200 }).catch(
                      () => null,
                    );
                  }
                  const payload = await bridge.request<RemotePayload | null>(
                    'WAIT_TIMEDTEXT',
                    {
                      videoId,
                      timeoutMs,
                      tlang: langPlan().tlang,
                      langs: langPlan().langs,
                      // A 方案：目标语言还没有捕获时，让播放器主动切一次 CC 轨道
                      autoSwitch: getPrefs().autoSwitchTrack,
                    },
                    timeoutMs + 3000,
                  );
                  return toOutcome(payload);
                }
              : undefined,
            // 主路径：MAIN world 里直接问 get_transcript，一次拿回全部分段
            structured: bridgeUp
              ? async () => {
                  // 同油猴端：不因为选了目标语言就跳过主路径，
                  // 拿到结果再按语言过滤（要翻译时只认目标语言的原生轨道）。
                  const payload = await bridge.request<RemotePayload | null>(
                    'GET_TRANSCRIPT',
                    { videoId, langs: plan.langs },
                    8000,
                  );
                  const outcome = toOutcome(payload);
                  if (!outcome) return null;
                  // 面板永远只给视频**默认轨道**（params 没有语言位）。
                  // 指定了别的语言时不能拿它顶，否则就是「切中文显示英文」。
                  const got = outcome.track?.languageCode;
                  if (plan.tlang && got && !langMatches(got, plan.tlang)) {
                    throw Object.assign(
                      new Error(
                        `get_panel 只给默认轨 ${got}，要的是 ${plan.tlang}；` +
                          '在播放器里把字幕语言切成目标语言后点重试',
                      ),
                      { code: 'NO_CAPTION_TRACK' as const },
                    );
                  }
                  return outcome;
                }
              : undefined,
            // 同步预览：一次可见文本扫描，不点击、不等待、不滚动
            domPreview: readRendered,
            // 所有完整源都失败时退到它：页面已经渲染出字幕，就别报「没有字幕轨道」。
            // 这条要滚一屏屏读全，否则会漏前段（虚拟列表只渲染视口附近的行）。
            domFallback: readRenderedFull,
            onPreview: options?.onPreview,
            closePanel: () => closeTranscriptPanelIfOurs(document),
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
    // 页面内面板改为嵌入右栏；扩展自己的 Side Panel 不受影响。
    const sidebar = createSidebarPanel({ doc: document, css: panelCss, client });

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
    const refreshButton = async (): Promise<void> => {
      if (!readVideoId(window)) {
        removeEntryButton(document);
        return;
      }
      await ensureEntryButton({
        doc: document,
        label: 'Transcript',
        title: '在右栏打开字幕',
        onClick: () => {
          if (sidebar.isOpen()) {
            sidebar.hide();
            return;
          }
          if (!sidebar.show()) flashEntryButton(document, '当前页面没有右栏');
        },
      });
    };

    // MAIN world 的钩子把「YouTube 自己发出了字幕请求」转发过来 → 自动重载
    bridge.on('CAPTURE', (raw) => {
      const payload = raw as { kind?: string; videoId?: string | null } | null;
      if (payload?.kind !== 'get_transcript') return;
      if (payload.videoId && payload.videoId !== readVideoId(window)) return;
      if (session.store.getState().status !== 'error') return;
      void session.load(true);
    });

    // 先把右栏面板挂上（document_start 时右栏可能还没渲染，内部会自动重试）
    try {
      sidebar.ensureMounted();
    } catch (error) {
      log({ code: 'UNKNOWN', source: 'host', detail: `sidebar mount failed: ${String(error)}` });
    }
    session.sync();
    void refreshButton();
    // 定时对账：不依赖 locationchange，漏事件也能在 500ms 内跟上切页
    session.start();

    ctx.addEventListener(window, 'wxt:locationchange', () => {
      // 每一步独立隔离：挂载失败不能吃掉同步
      try {
        // 切页保持面板展开；右栏被重建时 ensureMounted 会挂回去
        sidebar.ensureMounted();
      } catch (error) {
        log({ code: 'UNKNOWN', source: 'host', detail: `sidebar remount failed: ${String(error)}` });
      }
      session.sync();
      void refreshButton();
    });

    ctx.onInvalidated(() => {
      session.dispose();
      sidebar.destroy();
    });
  },
});
