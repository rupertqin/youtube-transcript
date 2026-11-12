import { readCacheForVideo, writeCache } from '../core/cache';
import { findActiveIndex } from '../core/lines';
import { log } from '../core/log';
import { createStore, emptyPanelState, type Store } from '../core/store';
import type { ErrorCode, HarvestResult, PanelState } from '../core/types';
import { getLegacyDiagnostic } from '../core/dom/legacy';
import { readVideoId } from '../core/harvest/player';

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

  const applyResult = async (videoId: string, result: HarvestResult): Promise<void> => {
    store.setState({
      videoId,
      title: hooks.title(),
      status: 'ready',
      lines: result.lines,
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
        lines: result.lines,
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
        store.setState({
          videoId,
          title: cached.title || hooks.title(),
          status: 'ready',
          lines: cached.lines,
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
      store.setState({
        status: 'error',
        error: { code, detail: (error as Error).message },
        failures,
        lines: [],
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
    store.setState({ ...emptyPanelState(videoId), status: 'loading', title: hooks.title() });
    void load();
  };

  const onTimeUpdate = (event: Event): void => {
    const target = event.target as HTMLVideoElement | null;
    if (!target || target.tagName !== 'VIDEO') return;
    const state = store.getState();
    if (state.lines.length === 0) return;
    const index = findActiveIndex(state.lines, target.currentTime ?? 0);
    if (index !== state.activeIndex) store.setState({ activeIndex: index });
  };

  const seek = (seconds: number): void => {
    const video = win.document.querySelector('video') as HTMLVideoElement | null;
    if (!video || !Number.isFinite(seconds) || seconds < 0) return;
    video.currentTime = seconds;
    const state = store.getState();
    const index = findActiveIndex(state.lines, seconds);
    if (index >= 0 && index !== state.activeIndex) store.setState({ activeIndex: index });
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
