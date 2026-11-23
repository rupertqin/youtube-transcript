import {
  ENTRY_BUTTON_ID,
  ensureEntryButton,
  entryButtonAction,
  flashEntryButton,
  hasNoCaptions,
  removeEntryButton,
  setEntryButtonOpen,
  setEntryButtonUnavailable,
} from '../dom/button';
import { getDomDiagnostic, readDomPreview, readRenderedTranscript } from '../dom/native-panel';
import { closeTranscriptPanelIfOurs, ensureFreshTranscriptRequest } from '../dom/panel';
import { sleep } from '../dom/wait';
import { readChapters } from '../format/copy';
import { harvestTranscript } from '../harvest/chain';
import { fetchPanelTranscript, panelLangSatisfies } from '../harvest/get-panel';
import type { TimedTextHook } from '../harvest/intercept';
import {
  readAvailableLangs,
  readOwnCaptionLangs,
  readPlayerResponse,
  readPlayerVideoId,
  readStoryboardSpec,
  readTitleFor,
  readVideoDuration,
  videoIdFromHref,
} from '../harvest/player';
import { interceptWithAutoSwitch } from '../harvest/player-track';
import { runInterceptSource, runRemoteSources } from '../harvest/sources';
import { pickUsableChoice, preferOwnLangs, resolveLangPlan, type LangChoice } from '../langs';
import type { HarvestContext, HarvestResult, Logger, SourceOutcome } from '../types';
import { createSidebarPanel, type SidebarPanelHandle } from '../../ui/sidebar';
import { SITE_CAPS } from './registry';
import type {
  SiteAdapter,
  SiteHarvestInput,
  SiteMountInput,
  SitePanelHandle,
} from './types';

/** 扩展端 MAIN world 桥的最小面；油猴端不传。 */
export interface SiteBridge {
  request<T>(type: string, payload: unknown, timeoutMs: number): Promise<T>;
}

interface RemotePayload {
  lines: { start: number; dur: number; text: string }[];
  source: 'player' | 'innertube' | 'intercept';
  track?: SourceOutcome['track'];
  showTimestamps: boolean;
  failures?: SourceOutcome['failures'];
  complete?: boolean;
}

export interface YouTubeSiteOptions {
  win: Window;
  doc: Document;
  log: Logger;
  /** 油猴端：同进程的 timedtext hook。扩展端 hook 在 MAIN world，走 bridge。 */
  hook?: TimedTextHook | null;
  /** 扩展端：MAIN world 桥（playerResponse / timedtext / storyboard 都从这里出） */
  bridge?: SiteBridge | null;
  /** 桥可能晚于 content script 就绪：等它一下，失败就退化为纯 DOM */
  ensureBridge?: () => Promise<boolean>;
  /** 用户的语言偏好（由宿主注入，避免 core 依赖 ui） */
  readChoice?: () => LangChoice;
  /** A 方案开关 */
  autoSwitchTrack?: () => boolean;
}

function toOutcome(payload: RemotePayload | null): SourceOutcome | null {
  if (!payload || !Array.isArray(payload.lines)) return null;
  if (payload.lines.length === 0) {
    // 0 行也要把失败分类带回来：否则「200 但 0 段（POT/无面板）」这种
    // 有信息量的原因会在过桥时丢成 NETWORK_ERROR 或「没有字幕轨道」。
    if (!payload.failures?.length) return null;
    return {
      lines: [],
      source: payload.source ?? 'innertube',
      showTimestamps: payload.showTimestamps !== false,
      failures: payload.failures,
    };
  }
  return {
    lines: payload.lines,
    source: payload.source,
    track: payload.track,
    showTimestamps: payload.showTimestamps,
    failures: payload.failures ?? [],
    complete: payload.complete !== false,
  };
}

/**
 * YouTube 适配器。
 *
 * 抓取链本身一行没改：只是把「用 bridge 还是直接调」这个宿主差异收进这里，
 * 于是 content.ts 与 userscript/main.ts 里那两份几乎一样的 harvest 实现合成一份。
 */
export function createYouTubeSite(options: YouTubeSiteOptions): SiteAdapter {
  const { win, doc, log, hook, bridge } = options;
  const readChoice = options.readChoice ?? (() => 'auto' as const);
  const autoSwitch = options.autoSwitchTrack ?? (() => true);

  const videoIdOf = (location: { href: string }): string | null => {
    try {
      return videoIdFromHref(location.href);
    } catch {
      return null;
    }
  };
  const currentId = (): string | null => videoIdOf(win.location);
  const urlFor = (videoId: string): string | null =>
    videoId
      ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
      : null;

  /**
   * 语言表缓存（按 videoId 归属）。
   *
   * 两个坑叠在一起，症状是「所有视频都变成中文、语言按钮消失」：
   *  ① 扩展端是 ISOLATED world，页面世界的 `ytInitialPlayerResponse` 在这里看不见，
   *     直接读永远是空数组 → 语言按钮从不出现；
   *  ② 抓取往往在 document_start 后几十毫秒就开始，那时响应还没注入 → 读到空表，
   *     `pickUsableChoice()` 于是「不敢降级」，用户上次选的「中文」被当成通用诉求。
   *     v2.29.4 之后机翻真的能用了，于是每个视频都被翻成中文。
   * 所以：过 MAIN world 桥读 + 按 videoId 缓存 + 算 plan 之前先等到读数。
   */
  interface LangInfo {
    langs: string[];
    /** 与视频音轨匹配的字幕语言（默认音轨自己的轨 → 音轨语言），「同音频」优先用它 */
    own: string[];
  }

  let langCache: { videoId: string } & LangInfo = { videoId: '', langs: [], own: [] };
  let langInflight: Promise<LangInfo> | null = null;
  let langInflightId = '';
  const langTriedAt = new Map<string, number>();

  const readLangsLocal = (videoId: string): LangInfo => ({
    langs: readAvailableLangs(win, videoId || undefined),
    own: readOwnCaptionLangs(win, videoId || undefined),
  });

  const fetchLangs = (videoId: string, timeoutMs = 1_200): Promise<LangInfo> => {
    if (!bridge || !videoId) return Promise.resolve(readLangsLocal(videoId));
    if (langInflight && langInflightId === videoId) return langInflight;
    langInflightId = videoId;
    langInflight = bridge
      .request<{ videoId?: string | null; langs?: string[]; own?: string[] } | null>(
        'READ_LANGS',
        { videoId },
        timeoutMs,
      )
      .then((payload) => {
        const info: LangInfo = {
          langs: Array.isArray(payload?.langs) ? payload.langs : [],
          own: Array.isArray(payload?.own) ? payload.own : [],
        };
        // 过桥期间可能已经切页：不属于这个视频的答案不写进缓存
        if (payload?.videoId && payload.videoId !== videoId) return info;
        langCache = { videoId, ...info };
        return info;
      })
      .catch(() => readLangsLocal(videoId))
      .finally(() => {
        langInflight = null;
      });
    return langInflight;
  };

  const availableLangs = (videoId: string): string[] => {
    if (videoId && langCache.videoId === videoId) return langCache.langs;
    const local = readLangsLocal(videoId).langs;
    if (local.length > 0) return local;
    // 扩展端这里必然为空：顺手补一次过桥，结果由下一轮 reconcile 读走
    if (bridge && videoId && Date.now() - (langTriedAt.get(videoId) ?? 0) > 2_000) {
      langTriedAt.set(videoId, Date.now());
      void fetchLangs(videoId).catch(() => undefined);
    }
    return local;
  };

  /**
   * 算 plan 之前先把语言表拿到手（最多等 ~600ms）。
   *
   * 空表 = 「不知道」，而 `pickUsableChoice` 对「不知道」刻意不降级；
   * 拿它去算 plan 就会把用户上次选的语言套到所有视频上。
   */
  const readLangsForPlan = async (videoId: string): Promise<LangInfo> => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const info = await fetchLangs(videoId, 1_000).catch(() => readLangsLocal(videoId));
      if (info.langs.length > 0) return info;
      if (attempt < 3) await sleep(200);
    }
    return readLangsLocal(videoId);
  };

  /** YouTube 能机翻（播放器 `translationLanguage`），所以目标语言不必有原生轨。 */
  const canTranslate = SITE_CAPS.youtube.machineTranslate;

  /**
   * 抓取与缓存读取共用这份 plan（await 过语言表），保证两者永远同一语言。
   *
   * 「同音频」还要把**视频自己的听写**排到最前：中文浏览器看日文视频时，
   * 按浏览器语言会先去要中文（拿不到就机翻），而那并不是视频的听写。
   */
  const resolvePlan = async (videoId: string) => {
    const info = await readLangsForPlan(videoId);
    const plan = resolveLangPlan(pickUsableChoice(readChoice(), info.langs, canTranslate));
    return preferOwnLangs(plan, info.own);
  };

  const site: SiteAdapter = {
    id: 'youtube',
    capabilities: SITE_CAPS.youtube,
    cacheNamespace: 'youtube',
    entryLabel: 'Transcript',

    match: (url) => url.hostname.endsWith('youtube.com'),
    videoIdOf,
    url: urlFor,
    playerVideoId: () => readPlayerVideoId(win),
    title: (videoId) => readTitleFor(win, videoId),
    duration: () => readVideoDuration(win),
    chapters: () => readChapters(doc),
    storyboard: async (videoId) => {
      if (!bridge) return readStoryboardSpec(win, videoId);
      if (options.ensureBridge && !(await options.ensureBridge())) return null;
      try {
        return await bridge.request<string | null>('STORYBOARD', null, 2500);
      } catch {
        return null;
      }
    },
    availableLangs,
    langPlan: () =>
      resolveLangPlan(pickUsableChoice(readChoice(), availableLangs(currentId() ?? ''), canTranslate)),
    resolvePlan,
    choice: (videoId) => pickUsableChoice(readChoice(), availableLangs(videoId), canTranslate),

    closeNativePanel: () => closeTranscriptPanelIfOurs(doc),
    diagnostic: () => getDomDiagnostic(),

    harvest: (input) => harvest(input),

    mount(input: SiteMountInput): SitePanelHandle {
      const sidebar: SidebarPanelHandle = createSidebarPanel({
        doc: input.doc,
        css: input.css,
        client: input.client,
        currentVideoId: input.currentVideoId,
        onToggle: (open) => setEntryButtonOpen(doc, open),
      });

      const applyNoCaptions = (): void => {
        setEntryButtonUnavailable(doc, hasNoCaptions(input.client.getState()));
      };
      const unsubscribeState = input.client.subscribe((state) => {
        setEntryButtonUnavailable(doc, hasNoCaptions(state));
      });
      applyNoCaptions();

      /**
       * 入口按钮与「当前页面有没有视频」保持同步。
       *
       * 只靠 locationchange 不够，两个真实故障都出在这里：
       *  ① YouTube 的 SPA 切页不保证触发宿主那次回调（首页 → 观看页时，
       *     右栏卡片自己挂上了，按钮却要刷新页面才出现）；
       *  ② 切页时 YouTube 会重建 masthead，把我们插进 `#end` 的按钮一起冲掉，
       *     而卡片有 MutationObserver 兜着、按钮没有。
       * 所以挂一个轻量定时器，每 800ms 对一次账：该在不在就补，不该在就删。
       */
      let buttonTimer = 0;
      let buttonSyncing = false;

      const syncEntryButton = async (): Promise<void> => {
        if (buttonSyncing) return;
        buttonSyncing = true;
        try {
          const action = entryButtonAction({
            hasVideo: Boolean(currentId()),
            button: doc.getElementById(ENTRY_BUTTON_ID),
          });
          if (action === 'remove') {
            removeEntryButton(doc);
            return;
          }
          if (action === 'insert') {
            await ensureEntryButton({
              doc,
              label: site.entryLabel,
              title: '展开 / 收起字幕',
              onClick: () => {
                if (sidebar.isOpen()) {
                  sidebar.hide();
                  return;
                }
                if (!sidebar.show()) flashEntryButton(doc, '当前页面没有右栏');
              },
            });
            // 等锚点的这段时间里用户可能已经离开观看页（masthead 起晚了会等几秒），
            // ensureEntryButton 自己不认页面，这里必须复查 —— 否则按钮会留在首页。
            if (!currentId()) {
              removeEntryButton(doc);
              return;
            }
          }
          setEntryButtonOpen(doc, sidebar.isOpen());
          applyNoCaptions();
        } catch (error) {
          // 定时器里抛异常不能外溢，也不能让 buttonSyncing 卡住
          log({ code: 'UNKNOWN', source: 'dom', detail: `entry button sync failed: ${String(error)}` });
        } finally {
          buttonSyncing = false;
        }
      };

      const startButtonWatch = (): void => {
        if (buttonTimer) return;
        buttonTimer = win.setInterval(() => {
          void syncEntryButton();
        }, 800);
      };

      void syncEntryButton();
      startButtonWatch();

      return {
        ensureMounted() {
          const mounted = sidebar.ensureMounted();
          void syncEntryButton();
          return mounted;
        },
        show: () => sidebar.show(),
        hide: () => sidebar.hide(),
        toggle: () => sidebar.toggle(),
        isOpen: () => sidebar.isOpen(),
        destroy() {
          unsubscribeState();
          if (buttonTimer) win.clearInterval(buttonTimer);
          buttonTimer = 0;
          sidebar.destroy();
          removeEntryButton(doc);
        },
      };
    },
  };

  async function harvest(input: SiteHarvestInput): Promise<HarvestResult> {
    const { videoId, signal, onStage, options: harvestOptions } = input;
    // 先等到真正的语言表再算 plan：读不到就当成「不知道」会不降级，
    // 用户上次选的语言会被套到这个视频上（见 availableLangs 的注释）
    const plan = await resolvePlan(videoId);

    /** 面板只给默认轨：语言未知也算不满足（见 `panelLangSatisfies`）。 */
    const panelMatchesTarget = (lang: string | null | undefined): boolean =>
      panelLangSatisfies(lang, plan.tlang);

    const domOptions = () => ({
      videoId,
      skipSnapshot: harvestOptions?.staleRisk,
      avoidSignature: harvestOptions?.avoid ?? null,
    });
    // 页面已渲染的字幕：先当临时预览，所有完整源都失败时再当兜底（不进缓存）
    const readRendered = (): SourceOutcome | null => {
      const result = readDomPreview(doc, domOptions());
      if (result.lines.length === 0) return null;
      return {
        lines: result.lines,
        source: 'dom',
        showTimestamps: result.showTimestamps,
        complete: false,
      };
    };
    const readRenderedFull = async (): Promise<SourceOutcome | null> => {
      const result = await readRenderedTranscript(doc, domOptions());
      if (result.lines.length === 0) return null;
      return {
        lines: result.lines,
        source: 'dom',
        showTimestamps: result.showTimestamps,
        complete: false,
      };
    };

    // 油猴端：同进程直接调；扩展端：全部经 MAIN world 桥
    const direct = Boolean(hook);
    const bridgeUp = direct ? false : bridge ? ((await options.ensureBridge?.()) ?? true) : false;

    const ctx: HarvestContext | null = direct
      ? {
          videoId,
          langs: plan.langs,
          tlang: plan.tlang,
          // 面板捕获永远是默认轨道：判断「语言未知的捕获能否满足需求」要用它
          defaultLang: readPlayerResponse(win)?.videoDetails?.defaultAudioLanguage ?? null,
          signal,
          log,
        }
      : null;

    const structured = direct
      ? async (): Promise<SourceOutcome | null> => {
          const outcome = await fetchPanelTranscript({
            win,
            fetchFn: win.fetch.bind(win),
            videoId,
            signal,
            timeoutMs: 6_000,
          });
          if (!outcome || outcome.lines.length === 0) return null;
          if (!panelMatchesTarget(outcome.lang)) {
            throw Object.assign(
              new Error(
                `get_panel 只给默认轨 ${outcome.lang ?? '（语言未知）'}，要的是 ${plan.tlang}；` +
                  '在播放器里把字幕语言切成目标语言后点重试',
              ),
              { code: 'NO_CAPTION_TRACK' as const },
            );
          }
          return {
            lines: outcome.lines,
            source: 'innertube',
            track: outcome.lang ? { baseUrl: `structured:${videoId}`, languageCode: outcome.lang } : undefined,
            showTimestamps: true,
            complete: true,
          };
        }
      : bridgeUp
        ? async (): Promise<SourceOutcome | null> => {
            const payload = await bridge!.request<RemotePayload | null>(
              'GET_TRANSCRIPT',
              { videoId, langs: plan.langs },
              8000,
            );
            const outcome = toOutcome(payload);
            if (!outcome) return null;
            // 0 行但带 failures 的结果直接放行：让上层把真实错误码记进诊断
            if (outcome.lines.length === 0) return outcome;
            const got = outcome.track?.languageCode;
            if (!panelMatchesTarget(got)) {
              throw Object.assign(
                new Error(
                  `get_panel 只给默认轨 ${got ?? '（语言未知）'}，要的是 ${plan.tlang}；` +
                    '在播放器里把字幕语言切成目标语言后点重试',
                ),
                { code: 'NO_CAPTION_TRACK' as const },
              );
            }
            return outcome;
          }
        : undefined;

    const remote = direct
      ? () => runRemoteSources({ win, ctx: ctx! })
      : bridgeUp
        ? async (): Promise<SourceOutcome | null> => {
            const payload = await bridge!.request<RemotePayload | null>(
              'HARVEST_REMOTE',
              { videoId, langs: plan.langs, tlang: plan.tlang },
              25000,
            );
            return toOutcome(payload);
          }
        : undefined;

    const cachedIntercept = direct
      ? () => runInterceptSource(ctx!, hook!, 0)
      : bridgeUp
        ? async (): Promise<SourceOutcome | null> => {
            const payload = await bridge!.request<RemotePayload | null>(
              'WAIT_TIMEDTEXT',
              { videoId, timeoutMs: 0, tlang: plan.tlang, langs: plan.langs },
              3000,
            );
            return toOutcome(payload);
          }
        : undefined;

    const intercept = direct
      ? async (timeoutMs: number): Promise<SourceOutcome | null> => {
          // CC 关着时播放器不发 timedtext，但原生面板与 CC 无关：
          // 面板已开着时收起再点开，逼它重新请求。
          // 指定了产出语言时不点：面板永远只给默认轨，点开只会闪一下被拒。
          if (!plan.tlang) {
            await ensureFreshTranscriptRequest(doc, { timeoutMs: 1_200 }).catch(() => null);
          }
          return interceptWithAutoSwitch({
            win,
            hook: hook!,
            ctx: ctx!,
            timeoutMs,
            enabled: autoSwitch(),
          });
        }
      : bridgeUp
        ? async (timeoutMs: number): Promise<SourceOutcome | null> => {
            if (!plan.tlang) {
              await ensureFreshTranscriptRequest(doc, { timeoutMs: 1_200 }).catch(() => null);
            }
            const payload = await bridge!.request<RemotePayload | null>(
              'WAIT_TIMEDTEXT',
              {
                videoId,
                timeoutMs,
                tlang: plan.tlang,
                langs: plan.langs,
                autoSwitch: autoSwitch(),
              },
              timeoutMs + 3000,
            );
            return toOutcome(payload);
          }
        : undefined;

    return harvestTranscript({
      signal,
      log,
      onStage,
      // 不再「要翻译就先问远程」：`&tlang=` 被 429 挡死（实测必失败），
      // 现在翻译由拦截层借播放器的自动翻译拿，远程只会白花一次请求
      // 并把最终错误码污染成 RATE_LIMITED（用户会看到「请求过于频繁」）。
      structured,
      remote,
      cachedIntercept,
      intercept,
      domPreview: readRendered,
      domFallback: readRenderedFull,
      onPreview: harvestOptions?.onPreview,
      closePanel: () => closeTranscriptPanelIfOurs(doc),
    });
  }

  return site;
}
