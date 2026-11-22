import {
  ensureEntryButton,
  flashEntryButton,
  hasNoCaptions,
  removeEntryButton,
  setEntryButtonOpen,
  setEntryButtonUnavailable,
} from '../dom/button';
import { getDomDiagnostic, readDomPreview, readRenderedTranscript } from '../dom/native-panel';
import { closeTranscriptPanelIfOurs, ensureFreshTranscriptRequest } from '../dom/panel';
import { readChapters } from '../format/copy';
import { harvestTranscript } from '../harvest/chain';
import { fetchPanelTranscript } from '../harvest/get-panel';
import type { TimedTextHook } from '../harvest/intercept';
import {
  hasNativeTrackFor,
  readAvailableLangs,
  readPlayerResponse,
  readPlayerVideoId,
  readStoryboardSpec,
  readTitleFor,
  readVideoDuration,
  videoIdFromHref,
} from '../harvest/player';
import { interceptWithAutoSwitch } from '../harvest/player-track';
import { runInterceptSource, runRemoteSources } from '../harvest/sources';
import { langMatches, pickUsableChoice, resolveLangPlan, type LangChoice } from '../langs';
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
  if (!payload || !Array.isArray(payload.lines) || payload.lines.length === 0) return null;
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

  const availableLangs = (videoId: string): string[] =>
    readAvailableLangs(win, videoId || undefined);

  const site: SiteAdapter = {
    id: 'youtube',
    capabilities: SITE_CAPS.youtube,
    cacheNamespace: 'youtube',
    entryLabel: 'Transcript',

    match: (url) => url.hostname.endsWith('youtube.com'),
    videoIdOf,
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
    langPlan: () => resolveLangPlan(pickUsableChoice(readChoice(), availableLangs(currentId() ?? ''))),
    choice: (videoId) => pickUsableChoice(readChoice(), availableLangs(videoId)),

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

      const refreshButton = async (): Promise<void> => {
        if (!currentId()) {
          removeEntryButton(doc);
          return;
        }
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
        setEntryButtonOpen(doc, sidebar.isOpen());
        applyNoCaptions();
      };
      void refreshButton();

      return {
        ensureMounted() {
          const mounted = sidebar.ensureMounted();
          void refreshButton();
          return mounted;
        },
        show: () => sidebar.show(),
        hide: () => sidebar.hide(),
        toggle: () => sidebar.toggle(),
        isOpen: () => sidebar.isOpen(),
        destroy() {
          unsubscribeState();
          sidebar.destroy();
          removeEntryButton(doc);
        },
      };
    },
  };

  async function harvest(input: SiteHarvestInput): Promise<HarvestResult> {
    const { videoId, signal, onStage, options: harvestOptions } = input;
    const plan = site.langPlan();
    // 没有目标语言的原生轨道时，拦截层 / DOM 层只能给原文 —— 必须让远程先上
    const needsTranslation = Boolean(plan.tlang) && !hasNativeTrackFor(win, plan.tlang!);

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
          // 面板永远只给视频**默认轨道**（params 里没有语言位）。
          // 用户指定了别的语言时拿它顶就是「切中文显示英文」，宁可失败。
          if (plan.tlang && outcome.lang && !langMatches(outcome.lang, plan.tlang)) {
            throw Object.assign(
              new Error(
                `get_panel 只给默认轨 ${outcome.lang}，要的是 ${plan.tlang}；` +
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
      preferRemote: needsTranslation,
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
