import { dropCacheEntry, readCacheForVideo, writeCache } from '../core/cache';
import { findActiveIndex, mergeFragments, transcriptFitsDuration } from '../core/lines';
import { log } from '../core/log';
import { createStore, emptyPanelState, type Store } from '../core/store';
import type { ErrorCode, HarvestResult, PanelState, TranscriptLine } from '../core/types';
import { cleanLines } from '../core/format/copy';
import { contentSignature } from '../core/format/fingerprint';
import type { SiteAdapter, SiteHarvestOptions } from '../core/site/types';

/** 每一层兜底对应的用户可读提示（面板加载态里显示）。 */
const STAGE_TEXT: Record<'player' | 'innertube' | 'intercept' | 'dom' | 'panel', string> = {
  player: '读取播放器字幕轨道…',
  innertube: '读取完整字幕分段…',
  intercept: '等待播放器发出字幕请求…',
  panel: '检查原生字幕面板…',
  dom: '读取已渲染的字幕…',
};

/** 抓取上下文的语义见 `site/types.ts` 的 `SiteHarvestOptions`。 */
export type HarvestOptions = SiteHarvestOptions;

export interface SessionOptions {
  win: Window;
  /**
   * 站点实现。会话层只认这一层：视频 id、标题、章节、语言、抓取、原生面板收合
   * 全部从站点来 —— 换站点不需要动这里一行。
   */
  site: SiteAdapter;
}

export interface Session {
  store: Store<PanelState>;
  load(force?: boolean): Promise<void>;
  /** 立即对账一次（幂等）。入口在 locationchange 时调用。 */
  sync(): void;
  /** 起定时对账循环，让面板不依赖任何单次事件也能跟上切页。 */
  start(): void;
  seek(seconds: number): void;
  dispose(): void;
}

/**
 * 两个宿主共用的会话逻辑：URL 同步、缓存、抓取、播放跟踪、seek。
 * 不在 core 里，因为它需要真实 DOM（video 元素），但仍然不认识 chrome.*。
 */
export function createSession(options: SessionOptions): Session {
  const { win, site } = options;
  const store = createStore<PanelState>(emptyPanelState());

  /** 地址栏现在这条视频；site 负责解析（YouTube `?v=` / B 站 BV+分P）。 */
  const currentVideoId = (): string | null => {
    try {
      return site.videoIdOf(win.location);
    } catch {
      return null;
    }
  };

  let controller: AbortController | null = null;
  let inflight = 0;
  /** 下一次 load 是否发生在「视频刚切换」之后 */
  let switchPending = false;
  /**
   * 切换前那条视频的内容指纹。
   *
   * 只在换台时写入、成功抓到新内容后清空。DOM 层拿它把「旧面板里还没刷新的
   * 那批行」判出来丢掉 —— 这批行没有 videoId，别的手段都认不出来。
   */
  let staleSignature: string | null = null;

  /**
   * 缓存里的字幕是否装得进这条视频。
   * 留 60s 容差：ASR 末条常常略微超过片长，用户也可能看到片尾推荐位。
   */
  const fitsVideoDuration = (lines: TranscriptLine[], videoId: string): boolean =>
    transcriptFitsDuration(lines, site.duration(videoId));

  /** storyboard 走站点：扩展端它穿 MAIN world 桥，油猴端就地读；失败一律降级成 null。 */
  const loadStoryboard = async (videoId: string): Promise<string | null> => {
    try {
      return await site.storyboard(videoId);
    } catch {
      return null;
    }
  };

  /**
   * 章节也来自页面 DOM，同样会受切页窗口期影响。
   * 只有「确定播放器已经在播别的视频」时才拒绝；取不到 id（还在加载）就照常读，
   * 否则首屏会白白丢掉章节。
   */
  const readChaptersIfCurrent = (videoId: string): PanelState['chapters'] => {
    const actual = site.playerVideoId();
    if (actual && actual !== videoId) return [];
    try {
      return site.chapters();
    } catch {
      return [];
    }
  };

  const applyResult = async (
    videoId: string,
    result: HarvestResult,
    context: { staleRisk?: boolean } = {},
  ): Promise<void> => {
    // 抓取期间用户可能已经切走：这份结果属于旧视频，直接丢掉
    const currentId = currentVideoId();
    if (currentId && currentId !== videoId) {
      log({
        code: 'UNKNOWN',
        source: 'host',
        detail: `drop stale result: expected=${videoId} actual=${currentId}`,
      });
      return;
    }

    // 无障碍时长短语（"33 minutes, 26 seconds"）在进 state 前统一洗掉，
    // 显示、搜索、复制、导出都基于同一份干净文本
    // 缓存存「清洗后的原始分段」，展示才合并成句子：
    // 否则命中缓存时会二次合并，行越粘越长（cleanLines 在两条路径都会跑）。
    const lines = cleanLines(result.lines);
    const displayLines = mergeFragments(lines);
    const chapters = readChaptersIfCurrent(videoId);
    const storyboard = await loadStoryboard(videoId);
    store.setState({
      videoId,
      site: site.id,
      title: site.title(videoId),
      status: 'ready',
      lines: displayLines,
      complete: result.complete !== false,
      mergeStats: { raw: lines.length, merged: displayLines.length },
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

    // 新视频的内容已经就位：指纹这道闸门到此为止，后续重试不该再拿旧内容比对
    staleSignature = null;

    // 只有完整结果能进缓存。DOM 预览只有视口内的几十行，写进去就会把
    // 「缺前段」固化 7 天 —— 用户只能靠「清空缓存并重新抓取」看到全量。
    const cacheable = result.complete !== false;

    if (result.lines.length > 0 && cacheable) {
      await writeCache(
        {
          site: site.cacheNamespace,
          videoId,
          lang: result.track?.languageCode ?? 'na',
          kind: result.track?.kind ?? 'manual',
          title: store.getState().title,
          source: result.source,
          lines,
          chapters,
          showTimestamps: result.showTimestamps,
          savedAt: Date.now(),
          complete: true,
        },
        // 归属守卫：播放器此刻不在这个视频上，就不能把内容算到它头上。
        // 少了这一步，一次「切页窗口期抓到上一页」会把错误内容固化 7 天。
        { site: site.cacheNamespace, playerVideoId: site.playerVideoId() },
      );
    }
  };

  const load = async (force = false): Promise<void> => {
    const state = store.getState();
    const videoId = state.videoId;
    if (!videoId) return;

    // 只对「切页后的第一次抓取」生效：此时页面里可能还留着上一个视频的行。
    // 重试（force）时面板已按当前视频重建过，正常走快照即可。
    const staleRisk = switchPending;
    switchPending = false;

    inflight += 1;
    const run = inflight;

    if (!force) {
      // 选中文就不能拿上次缓存的英文
      const wantedLang = site.langPlan().tlang;
      const cached = await readCacheForVideo(site.cacheNamespace, videoId, wantedLang);
      if (run !== inflight) return;

      // 内容的物理一致性校验：字幕最后一条不可能晚于视频结束。
      // 超了就说明这条缓存其实是**别的视频**的字幕（早期版本在切页窗口期写错的），
      // 它的 videoId 是对的，光比 id 永远发现不了。
      if (cached && !fitsVideoDuration(cached.lines, videoId)) {
        log({
          code: 'UNKNOWN',
          source: 'cache',
          detail: `丢弃不属于 ${videoId} 的缓存：末条 ${cached.lines[cached.lines.length - 1]?.start}ms 超出视频时长`,
        });
        await dropCacheEntry(cached.key);
        return load(force);
      }

      if (cached) {
        const storyboard = await loadStoryboard(videoId);
        const rawLines = cleanLines(cached.lines);
        const displayLines = mergeFragments(rawLines);
        store.setState({
          videoId,
          site: site.id,
          title: cached.title || site.title(videoId),
          status: 'ready',
          lines: displayLines,
          complete: true,
          mergeStats: { raw: rawLines.length, merged: displayLines.length },
          chapters:
            cached.chapters && cached.chapters.length > 0
              ? cached.chapters
              : readChaptersIfCurrent(videoId),
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
      mergeStats: null,
      title: site.title(videoId),
      // 强制重抓通常意味着「换了语言」：旧行是另一种语言，留着只会误导
      ...(force ? { lines: [] as PanelState['lines'], activeIndex: -1 } : {}),
    });

    // 预览只在这条视频仍属于本次抓取时才允许写进 state
    const showPreview = (raw: TranscriptLine[]): void => {
      if (signal.aborted || run !== inflight || store.getState().videoId !== videoId) return;
      const cleaned = cleanLines(raw);
      const displayLines = mergeFragments(cleaned);
      store.setState({
        lines: displayLines,
        mergeStats: { raw: cleaned.length, merged: displayLines.length },
        status: 'loading',
        progress: '已读到页面字幕，正在取完整内容…',
        source: 'dom',
        cached: false,
        complete: false,
      });
    };

    try {
      // 不再先等播放器 12s / 10s：结构化源不依赖播放器就绪。
      // DOM 预览自己有 videoId 校验与内容指纹闸门，不会把旧视频文字当新的。
      const result = await site.harvest({
        videoId,
        signal,
        onStage: (stage) => {
          if (run !== inflight) return;
          store.setState({ progress: STAGE_TEXT[stage as keyof typeof STAGE_TEXT] ?? '正在抓取…' });
        },
        // 指纹**不看 force**：force 既用于换语言，也用于「失败后重试」。
        // 重试恰恰是最容易再读到旧面板的时刻，这时候撤掉闸门等于前功尽弃。
        options: { staleRisk, avoid: staleSignature, onPreview: showPreview },
      });
      if (signal.aborted || run !== inflight) return;
      if (result.lines.length === 0) throw Object.assign(new Error('empty transcript'), { code: 'NO_CAPTION_TRACK' });
      await applyResult(videoId, result, { staleRisk });
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
        complete: true,
        mergeStats: null,
        source: null,
        // 抓取失败时章节仍可用：它是页面上的独立数据，不依赖字幕请求
        chapters: readChaptersIfCurrent(videoId),
        storyboard,
        progress: null,
        // 诊断文本首行印版本号：复制文本发出来就能立刻确认跑的是哪一版
        diagnostic:
          [
            `脚本版本: v${typeof __YTT_VERSION__ === 'string' ? __YTT_VERSION__ : 'dev'}`,
            site.diagnostic() ?? '',
          ]
            .filter((line) => line.length > 0)
            .join('\n') || null,
        updatedAt: Date.now(),
      });
      log({ code, source: 'host', detail: String((error as Error).message) });
    }
  };

  /**
   * 把面板状态对齐到「地址栏现在这条视频」。
   *
   * 幂等且极便宜（一次 URL 解析 + 一次字符串比较），所以可以 500ms 跑一次。
   * 这是整套逻辑的唯一真相来源：不依赖任何事件回调，漏事件、回调抛异常
   * 都能在下一轮自己修回来 —— 否则面板会静默冻结在上一个视频上。
   */
  const reconcile = (): void => {
    const videoId = currentVideoId();
    const current = store.getState();

    if (!videoId) {
      if (current.videoId) {
        controller?.abort();
        store.setState({ ...emptyPanelState(''), site: site.id, status: 'idle' });
        site.onNavigate?.(null);
      }
      return;
    }

    if (videoId === current.videoId && current.status !== 'idle') {
      // 顺带校正标题：切页那一瞬间 title() 可能读到还没更新的 document.title，
      // 写进去之后就没有第二次机会了。这里每轮对一次，读到的才算数。
      const title = site.title(videoId);
      if (title && title !== current.title) store.setState({ title });

      // 可用语言同理：轨道列表往往比地址栏晚一步就绪（B 站要等接口回来），
      // 语言按钮要等它到了才出现，所以每轮对一次。
      const langs = site.availableLangs(videoId);
      if (langs.length !== current.availableLangs.length || langs.some((l, i) => l !== current.availableLangs[i])) {
        store.setState({ availableLangs: langs });
      }
      return;
    }

    // 换视频了：YouTube 不会销毁展开着的原生字幕面板，里面还是上一个视频的行，
    // 而且这些行没有任何 videoId 标记。先把它收掉，让下面的抓取按新视频重建。
    if (current.videoId && current.videoId !== videoId) {
      // 必须**在清空 state 之前**取指纹：清完 current.lines 就没了，
      // 那之后就再也说不清「页面上这批行是不是旧的」。
      staleSignature = current.lines.length > 0 ? contentSignature(current.lines) : null;
      // 标记这一次是「换视频」：DOM 层的现有快照不可信
      switchPending = true;
      // 站内短期缓存（轨道列表等）按新视频重来
      site.onNavigate?.(videoId);
      // 异步确认式收起：点一下经常赶不上 YouTube 的 DOM 更新，
      // 旧版本因此把面板留在页面上（用户看到的「原生字幕不会消失」）。
      // 只收**我们自己点开**的：用户手动开的那个去点关闭，屏幕上就是「字幕框闪一下」。
      // 旧面板的内容由 staleRisk（内容指纹闸门）挡着，不靠关面板来保证归属。
      void Promise.resolve(site.closeNativePanel?.())
        .then((closed) => {
          if (closed) {
            log({ code: 'UNKNOWN', source: 'dom', detail: `已收起 ${current.videoId} 残留的原生字幕面板` });
          }
        })
        .catch(() => undefined);
    }

    controller?.abort();
    // 章节先清空：此刻读到的必然是上一个视频的章节，
    // 由 load() 在 videoId 对齐后重新填充
    store.setState({
      ...emptyPanelState(videoId),
      site: site.id,
      status: 'loading',
      title: site.title(videoId),
      availableLangs: site.availableLangs(videoId),
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

  /* ---------------- 定时自愈 ---------------- */

  /** 多久对账一次。500ms 与人眼「感觉卡住了」的阈值同量级，成本可忽略。 */
  const RECONCILE_MS = 500;
  let reconcileTimer = 0;

  /**
   * 起一个自愈循环。
   *
   * 为什么不只依赖入口的 locationchange / tick：
   * 那条链一旦在中间抛异常（例如侧栏挂载失败），这次同步就被静默跳过，
   * 而 URL 已被记成「处理过」，于是面板永久停在旧视频上。定时对账不经过
   * 任何回调，异常也吞在内部，最多晚 500ms 就纠正回来。
   */
  const start = (): void => {
    if (reconcileTimer) return;
    // 立刻跑一次，别等第一个 500ms
    safeReconcile();
    reconcileTimer = win.setInterval(safeReconcile, RECONCILE_MS);
  };

  function safeReconcile(): void {
    try {
      reconcile();
    } catch (error) {
      // 自愈循环自己绝不能死：记一条然后等下一轮
      try {
        log({ code: 'UNKNOWN', source: 'host', detail: `reconcile failed: ${String(error)}` });
      } catch {
        /* 日志也失败就算了，不能影响下一轮 */
      }
    }
  }

  return {
    store,
    load,
    sync: safeReconcile,
    start,
    seek,
    dispose() {
      if (reconcileTimer) win.clearInterval(reconcileTimer);
      reconcileTimer = 0;
      controller?.abort();
      win.document.removeEventListener('timeupdate', onTimeUpdate, true);
    },
  };
}
