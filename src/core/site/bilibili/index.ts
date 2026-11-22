import { harvestTranscript } from '../../harvest/chain';
import { pickUsableChoice, resolveLangPlan, type LangChoice } from '../../langs';
import type { ErrorCode, FailureRecord, HarvestResult, Logger, SourceOutcome } from '../../types';
import { createSidebarWithEntryButton } from '../../../ui/sidebar-entry';
import { SITE_CAPS } from '../registry';
import type { SiteAdapter, SiteHarvestInput, SiteMountInput, SitePanelHandle } from '../types';
import { createBiliApi, type BiliApi } from './api';
import { noSubtitleDetail } from './errors';
import {
  biliVideoKey,
  normalizeLang,
  normalizeTrack,
  parseBiliVideoId,
  parseSubtitleBody,
  pickBiliTrack,
  splitBiliVideoKey,
  withSourceHints,
  type BiliTrack,
} from './parse';
import { readBiliPageState, readRenderedSubtitle, type BiliPageSnapshot } from './page-state';

/**
 * `harvestTranscript` 抛的是 `HarvestError`，message 只有 `transcript harvest failed: XX`；
 * 「请登录」「风控，稍后重试」这些能照着做的细节只在 failures[] 里。
 * 这里把最有信息量的一条提到错误 message，让面板的 error.detail 直接说人话。
 */
async function surfaceBiliFailure(result: Promise<HarvestResult>): Promise<HarvestResult> {
  try {
    return await result;
  } catch (error) {
    const record = error as { code?: ErrorCode; failures?: FailureRecord[] };
    const useful = record.failures?.find(
      (item) => item.detail && item.detail !== 'no lines' && !item.detail.startsWith('transcript harvest failed'),
    );
    if (!useful) throw error;
    throw Object.assign(new Error(useful.detail), { code: useful.code, failures: record.failures });
  }
}

export interface BilibiliSiteOptions {
  win: Window;
  doc: Document;
  log: Logger;
  /** 用户语言偏好（宿主注入，core 不依赖 ui） */
  readChoice?: () => LangChoice;
  /**
   * 页面首屏状态（`__INITIAL_STATE__`）。
   *
   * 油猴端直接读；扩展的 content script 在 isolated world 读不到页面对象，
   * 必须经 MAIN world 桥转发 —— 所以这里统一是异步的。
   */
  readPageState?: () => Promise<BiliPageSnapshot | null>;
  /** 测试注入 */
  api?: BiliApi;
}

/** 站内短期状态：标题 / 时长 / 轨道列表，都是同步 getter 的数据来源。 */
export function createBilibiliSite(options: BilibiliSiteOptions): SiteAdapter {
  const { win, doc, log } = options;
  const readChoice = options.readChoice ?? (() => 'auto' as const);
  const api = options.api ?? createBiliApi({ win, log });
  const pageStateOf =
    options.readPageState ?? (async () => readBiliPageState(win));

  const titles = new Map<string, string>();
  const durations = new Map<string, number>();
  const tracksByVideo = new Map<string, BiliTrack[]>();
  /** videoId → 当前 cid；查接口时记下来，rememberTracks 复用它做 api 的短缓存 */
  const biliCidCache = new Map<string, number>();

  const videoIdOf = (location: { href: string }): string | null => {
    const parsed = parseBiliVideoId(location.href);
    return parsed ? biliVideoKey(parsed.bvid, parsed.page) : null;
  };
  const currentId = (): string | null => videoIdOf(win.location);

  function tracksFor(videoId: string): BiliTrack[] {
    return tracksByVideo.get(videoId) ?? [];
  }

  function rememberTracks(videoId: string, tracks: BiliTrack[]): void {
    tracksByVideo.set(videoId, tracks);
    const parsed = splitBiliVideoKey(videoId);
    if (parsed) api.rememberTracks(`${parsed.bvid}|${biliCidCache.get(videoId) ?? 0}`, tracks);
  }

  /** 轨道列表 → 归一化后的语言码（UI 只认这一份）。 */
  const availableLangs = (videoId: string): string[] => {
    const seen = new Set<string>();
    for (const track of tracksFor(videoId)) seen.add(normalizeLang(track.lan));
    return [...seen];
  };

  /**
   * 拿到轨道列表：页面首屏状态优先（0 请求），否则走 WBI 接口。
   * 同时把标题/时长/语言缓存起来，供同步 getter 使用。
   */
  async function ensureTracks(
    videoId: string,
    signal: AbortSignal,
  ): Promise<{ tracks: BiliTrack[]; cid: number }> {
    const parsed = splitBiliVideoKey(videoId);
    if (!parsed) {
      throw Object.assign(new Error(`无法从 ${videoId} 解析 BV 号`), { code: 'NO_CAPTION_TRACK' as const });
    }

    const pageState = await pageStateOf();
    if (pageState && pageState.bvid === parsed.bvid) {
      if (pageState.title) titles.set(videoId, pageState.title);
      if (pageState.duration) durations.set(videoId, pageState.duration);
      if (pageState.tracks.length > 0) {
        const cid = pageState.cid ?? 0;
        biliCidCache.set(videoId, cid);
        rememberTracks(videoId, pageState.tracks);
        return { tracks: pageState.tracks, cid };
      }
    }

    const view = await api.view(parsed.bvid, signal);
    titles.set(videoId, view.title);
    if (view.duration) durations.set(videoId, view.duration);
    const cid = view.pages.find((page) => page.page === parsed.page)?.cid ?? view.pages[0]?.cid ?? 0;
    biliCidCache.set(videoId, cid);

    // player 接口的轨道来源字段可能缺失，用 view.subtitle.list 交叉补齐
    const tracks = withSourceHints(await api.tracks(parsed.bvid, cid, signal), view.subtitle?.list ?? []);
    rememberTracks(videoId, tracks);
    return { tracks, cid };
  }

  /** 下载并解析选中轨道。 */
  async function loadTrack(track: BiliTrack, signal: AbortSignal): Promise<SourceOutcome> {
    if (!track.subtitle_url) {
      throw Object.assign(new Error('这条字幕还没有生成（subtitle_url 为空）'), {
        code: 'NO_CAPTION_TRACK' as const,
      });
    }
    const raw = await api.subtitle(track.subtitle_url, signal);
    const lines = parseSubtitleBody(raw);
    if (lines.length === 0) {
      throw Object.assign(new Error('字幕体解析出 0 行（接口结构可能变了）'), {
        code: 'EMPTY_200' as const,
      });
    }
    return {
      lines,
      source: 'innertube',
      track: normalizeTrack(track),
      showTimestamps: true,
      complete: true,
    };
  }

  const site: SiteAdapter = {
    id: 'bilibili',
    capabilities: SITE_CAPS.bilibili,
    cacheNamespace: 'bilibili',
    entryLabel: '字幕',

    match: (url) => url.hostname.endsWith('bilibili.com'),
    videoIdOf,
    /**
     * B 站没有 `getPlayerResponse` 这种权威接口，只能以地址栏为准。
     * 但内容归属仍然可靠：字幕体是按「请求时解析出的 bvid + cid」拿的，
     * 不会像 DOM 抓取那样把上一页的文字算到新视频头上。
     */
    playerVideoId: currentId,
    title: (videoId) => {
      const cached = titles.get(videoId);
      if (cached) return cached;
      return doc.title.replace(/\s*[-_]\s*哔哩哔哩.*$/u, '').replace(/^【[^】]*】\s*/u, '');
    },
    duration: (videoId) => {
      const cached = durations.get(videoId);
      if (cached) return cached;
      const video = doc.querySelector('video') as HTMLVideoElement | null;
      const live = Number(video?.duration);
      return Number.isFinite(live) && live > 0 ? live : null;
    },
    chapters: () => [],
    storyboard: async () => null,
    availableLangs,
    langPlan: () => {
      const choice = pickUsableChoice(readChoice(), availableLangs(currentId() ?? ''));
      const plan = resolveLangPlan(choice);
      // B 站没有 tlang 机翻：语言只决定挑哪条原生轨道
      return { langs: plan.langs, tlang: null };
    },
    choice: (videoId) => pickUsableChoice(readChoice(), availableLangs(videoId)),

    diagnostic: () => null,
    onNavigate: () => {
      api.reset();
    },

    async harvest(input: SiteHarvestInput): Promise<HarvestResult> {
      const { videoId, signal, onStage, options: harvestOptions } = input;
      const choice = site.choice(videoId);

      const domPreview = (): SourceOutcome | null => {
        const rendered = readRenderedSubtitle(win);
        if (!rendered) return null;
        return {
          lines: rendered.lines,
          source: 'dom',
          showTimestamps: rendered.showTimestamps,
          complete: false,
        };
      };

      return surfaceBiliFailure(harvestTranscript({
        signal,
        log,
        onStage,
        structured: async () => {
          const { tracks } = await ensureTracks(videoId, signal);
          if (tracks.length === 0) {
            throw Object.assign(new Error(noSubtitleDetail()), { code: 'NO_CAPTION_TRACK' as const });
          }
          const picked = pickBiliTrack(tracks, choice);
          if (!picked) {
            throw Object.assign(new Error(noSubtitleDetail()), { code: 'NO_CAPTION_TRACK' as const });
          }
          return loadTrack(picked, signal);
        },
        // 接口失败（未登录/风控/CORS）时的退路：首屏状态里的 subtitle_url 不需要签名
        remote: async () => {
          const pageState = await pageStateOf();
          if (!pageState || pageState.tracks.length === 0) return null;
          const picked = pickBiliTrack(pageState.tracks, choice);
          if (!picked?.subtitle_url) return null;
          log({
            code: 'OK',
            source: 'player',
            detail: '接口不可用，改用页面首屏数据里的字幕地址',
          });
          return loadTrack(picked, signal);
        },
        domPreview,
        domFallback: async () => {
          const rendered = readRenderedSubtitle(win);
          if (!rendered) return null;
          return {
            lines: rendered.lines,
            source: 'dom',
            showTimestamps: rendered.showTimestamps,
            complete: false,
          };
        },
        onPreview: harvestOptions?.onPreview,
      }));
    },

    mount(input: SiteMountInput): SitePanelHandle {
      // 与 YouTube 同一套交互：一个入口按钮 + 一个右栏卡片。
      // 只有抓取在背后按站点分开（这里走 WBI + 页面兜底），UI 不再有浮层分支。
      return createSidebarWithEntryButton({
        doc: input.doc,
        css: input.css,
        client: input.client,
        currentVideoId: input.currentVideoId,
        label: site.entryLabel,
        // B 站右栏比 YouTube 窄，卡片矮一些
        height: 'min(560px, 70vh)',
      });
    },
  };

  return site;
}
