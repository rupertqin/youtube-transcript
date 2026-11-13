import { readCacheForVideo, writeCache } from '../core/cache';
import { findActiveIndex } from '../core/lines';
import { log } from '../core/log';
import { createStore, emptyPanelState, type Store } from '../core/store';
import type { ErrorCode, HarvestResult, PanelState } from '../core/types';
import { getLegacyDiagnostic } from '../core/dom/legacy';
import { cleanLines, readChapters } from '../core/format/copy';
import { readStoryboardSpec, readVideoId } from '../core/harvest/player';

/** 每一层兜底对应的用户可读提示（面板加载态里显示）。 */
const STAGE_TEXT: Record<'player' | 'intercept' | 'dom' | 'panel', string> = {
  player: '读取播放器字幕轨道…',
  intercept: '等待播放器发出字幕请求…',
  panel: '正在打开 YouTube 原生字幕面板抓取…',
  dom: '从原生面板读取字幕…',
};

/** 等播放器实例出现：字幕轨道的读取依赖它，太早抓只会得到空轨道。 */
async function waitForPlayerReady(win: Window, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (win.document.querySelector('video') || win.document.querySelector('#movie_player')) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export interface SessionHooks {
  /** 由宿主注入：扩展 = 通过 bridge 拆 world 跑；油猴 = 同一个进程里跑 */
  harvest: (
    videoId: string,
    signal: AbortSignal,
    onStage: (stage: string) => void,
  ) => Promise<HarvestResult>;
  title: () => string;
  /**
   * storyboard 规格。扩展的 content script 在 isolated world，读不到页面的
   * playerResponse，必须由宿主通过 MAIN world bridge 取；不传则就地读。
   */
  storyboard?: (videoId: string) => Promise<string | null>;
}

export interface Session {
  store: Store<PanelState>;
  load(force?: boolean): Promise<void>;
  sync(): void;
  seek(seconds: number): void;
  dispose(): void;
}

/**
 * 两个宿主共用的会话逻辑：URL 同步、缓存、抓取、播放跟踪、seek。
 * 不在 core 里，因为它需要真实 DOM（video 元素），但仍然不认识 chrome.*。
 */
export function createSession(options: { win: Window; hooks: SessionHooks }): Session {
  const { win, hooks } = options;
  const store = createStore<PanelState>(emptyPanelState());

  let controller: AbortController | null = null;
  let inflight = 0;

  /**
   * 宿主要是提供了 storyboard 钩子就走它（扩展需要穿到 MAIN world），
   * 否则就地读 —— 油猴脚本本身就在页面上下文，直接就能拿到。
   * 失败一律降级成 null：没有截图不影响章节本身。
   */
  const loadStoryboard = async (videoId: string): Promise<string | null> => {
    try {
      if (hooks.storyboard) return await hooks.storyboard(videoId);
      return readStoryboardSpec(win);
    } catch {
      return null;
    }
  };

  const applyResult = async (videoId: string, result: HarvestResult): Promise<void> => {
    // 无障碍时长短语（"33 minutes, 26 seconds"）在进 state 前统一洗掉，
    // 显示、搜索、复制、导出都基于同一份干净文本
    const lines = cleanLines(result.lines);
    const chapters = readChapters(win.document);
    const storyboard = await loadStoryboard(videoId);
    store.setState({
      videoId,
      title: hooks.title(),
      status: 'ready',
      lines,
      chapters,
      storyboard,
      showTimestamps: result.showTimestamps,
      source: result.source,
      lang: result.track?.languageCode ?? null,
      cached: false,
      failures: result.failures,
      error: null,
      activeIndex: -1,
      progress: null,
      diagnostic: null,
      updatedAt: Date.now(),
    });

    if (result.lines.length > 0) {
      await writeCache({
        key: `${videoId}|${result.track?.languageCode ?? 'na'}|${result.track?.kind ?? 'manual'}`,
        videoId,
        lang: result.track?.languageCode ?? 'na',
        kind: result.track?.kind ?? 'manual',
        title: store.getState().title,
        source: result.source,
        lines,
        chapters,
        showTimestamps: result.showTimestamps,
        savedAt: Date.now(),
      });
    }
  };

  const load = async (force = false): Promise<void> => {
    const state = store.getState();
    const videoId = state.videoId;
    if (!videoId) return;

    inflight += 1;
    const run = inflight;

    if (!force) {
      const cached = await readCacheForVideo(videoId);
      if (run !== inflight) return;
      if (cached) {
        const storyboard = await loadStoryboard(videoId);
        store.setState({
          videoId,
          title: cached.title || hooks.title(),
          status: 'ready',
          lines: cleanLines(cached.lines),
          chapters: cached.chapters ?? readChapters(win.document),
          // storyboard 的签名会过期，不进缓存，每次从页面现读
          storyboard,
          showTimestamps: cached.showTimestamps,
          source: cached.source as PanelState['source'],
          lang: cached.lang,
          cached: true,
          failures: [],
          error: null,
          activeIndex: -1,
          updatedAt: Date.now(),
        });
        log({ code: 'OK', source: 'cache', meta: { lines: cached.lines.length } });
        return;
      }
    }

    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;

    store.setState({
      status: 'loading',
      error: null,
      cached: false,
      failures: [],
      progress: '准备抓取…',
      title: hooks.title(),
    });

    try {
      // document_start 时播放器还不存在，硬抓只会拿到「没有字幕轨道」
      await waitForPlayerReady(win, 12000);
      if (signal.aborted || run !== inflight) return;
      const result = await hooks.harvest(videoId, signal, (stage) => {
        if (run !== inflight) return;
        store.setState({ progress: STAGE_TEXT[stage as keyof typeof STAGE_TEXT] ?? '正在抓取…' });
      });
      if (signal.aborted || run !== inflight) return;
      if (result.lines.length === 0) throw Object.assign(new Error('empty transcript'), { code: 'NO_CAPTION_TRACK' });
      await applyResult(videoId, result);
    } catch (error) {
      if (signal.aborted || run !== inflight) return;
      const code = (error as { code?: ErrorCode }).code ?? 'UNKNOWN';
      const failures = (error as { failures?: PanelState['failures'] }).failures ?? store.getState().failures;
      const storyboard = await loadStoryboard(videoId);
      store.setState({
        status: 'error',
        error: { code, detail: (error as Error).message },
        failures,
        lines: [],
        // 抓取失败时章节仍可用：它是页面上的独立数据，不依赖字幕请求
        chapters: readChapters(win.document),
        storyboard,
        source: null,
        progress: null,
        // 诊断文本首行印版本号：复制文本发出来就能立刻确认跑的是哪一版
        diagnostic:
          [
            `脚本版本: v${typeof __YTT_VERSION__ === 'string' ? __YTT_VERSION__ : 'dev'}`,
            getLegacyDiagnostic(),
          ]
            .filter((line) => line.length > 0)
            .join('\n') || null,
        updatedAt: Date.now(),
      });
      log({ code, source: 'host', detail: String((error as Error).message) });
    }
  };

  const sync = (): void => {
    const videoId = readVideoId(win);
    const current = store.getState();

    if (!videoId) {
      if (current.videoId) {
        controller?.abort();
        store.setState({ ...emptyPanelState(''), status: 'idle' });
      }
      return;
    }

    if (videoId === current.videoId && current.status !== 'idle') return;

    controller?.abort();
    store.setState({
      ...emptyPanelState(videoId),
      chapters: readChapters(win.document),
      status: 'loading',
      title: hooks.title(),
    });
    // 截图规格可能要走异步桥，先渲染章节、稍后补图
    void loadStoryboard(videoId).then((spec) => {
      if (spec && store.getState().videoId === videoId) store.setState({ storyboard: spec });
    });
    void load();
  };

  const onTimeUpdate = (event: Event): void => {
    const target = event.target as HTMLVideoElement | null;
    if (!target || target.tagName !== 'VIDEO') return;
    const state = store.getState();
    const seconds = target.currentTime ?? 0;
    const positionMs = Math.max(0, Math.round(seconds * 1000));

    // 章节高亮只认真实播放位置；字幕高亮才用行索引。
    // 两者都要，否则章节视图永远停在上一章（activeIndex 的 start 早于章节起点）。
    // 没有章节时不记位置：positionMs 每次 timeupdate 都变，会白白多渲染几倍。
    // 按秒取整：章节是分钟级粒度，秒级足够，也避免每次 timeupdate 都渲染。
    const patch: Partial<PanelState> = {};
    if (state.chapters.length > 0) {
      const rounded = Math.floor(positionMs / 1000) * 1000;
      if (rounded !== state.positionMs) patch.positionMs = rounded;
    }
    if (state.lines.length > 0) {
      const index = findActiveIndex(state.lines, seconds);
      if (index !== state.activeIndex) patch.activeIndex = index;
    }
    if (Object.keys(patch).length > 0) store.setState(patch);
  };

  const seek = (seconds: number): void => {
    const video = win.document.querySelector('video') as HTMLVideoElement | null;
    if (!video || !Number.isFinite(seconds) || seconds < 0) return;
    video.currentTime = seconds;
    const state = store.getState();
    // 立即把位置写进状态：不等 timeupdate，点击的瞬间章节高亮就跳到目标
    const patch: Partial<PanelState> = { positionMs: Math.round(seconds * 1000) };
    if (state.lines.length > 0) {
      const index = findActiveIndex(state.lines, seconds);
      if (index >= 0) patch.activeIndex = index;
    }
    store.setState(patch);
  };

  win.document.addEventListener('timeupdate', onTimeUpdate, true);

  return {
    store,
    load,
    sync,
    seek,
    dispose() {
      controller?.abort();
      win.document.removeEventListener('timeupdate', onTimeUpdate, true);
    },
  };
}
