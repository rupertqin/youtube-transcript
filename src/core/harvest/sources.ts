import type { CaptionTrack, FailureRecord, HarvestContext, SourceOutcome, TranscriptLine } from '../types';
import type { CaptureKind, TimedTextCapture, TimedTextHook } from './intercept';
import { langMatches } from '../langs';
import { probeInnertube } from './innertube';
import { parseTimedText } from './parse';
import { parseGetTranscript } from './parse/transcript';
import {
  describePlayability,
  pickTrack,
  readCaptionTracks,
  readPlayerResponse,
} from './player';
import { fetchTimedText } from './timedtext';

type FetchLike = typeof fetch;

interface TrackAttempt {
  lines: { start: number; dur: number; text: string }[];
  failures: FailureRecord[];
  /** 实际拿到的语言：翻译过的话这里已经是目标语言 */
  track: CaptionTrack;
}

/**
 * 轨道逐格式尝试：json3 优先，空 200 / 解析失败再退 srv1。
 *
 * tlang 只在「轨道语言不满足目标」时才拼进 URL（让 YouTube 机器翻译）。
 * 返回的 track.languageCode 会被改写成**产出语言**，这样上层做缓存键、
 * 显示语言、判断是否达标时看到的都是真正拿到的语言。
 */
async function tryTrack(
  fetchFn: FetchLike,
  track: CaptionTrack,
  signal: AbortSignal,
  source: 'player' | 'innertube',
  tlang?: string | null,
): Promise<TrackAttempt> {
  const failures: FailureRecord[] = [];
  const translated = Boolean(tlang && !langMatches(track.languageCode, tlang));
  const effective: CaptionTrack = translated
    ? { ...track, languageCode: String(tlang) }
    : track;

  for (const fmt of ['json3', 'srv1'] as const) {
    const started = Date.now();
    const outcome = await fetchTimedText(
      fetchFn,
      track.baseUrl,
      fmt,
      signal,
      translated ? tlang : null,
    );
    if (outcome.lines.length > 0) return { lines: outcome.lines, failures, track: effective };
    failures.push({
      source,
      code: outcome.code ?? 'EMPTY_200',
      ms: Date.now() - started,
      detail: `${track.languageCode}${translated ? `→${tlang}` : ''}/${fmt}: ${outcome.detail ?? '0 lines'}`,
    });
  }

  return { lines: [], failures, track: effective };
}

/**
 * ② 播放器 captionTracks + ④ InnerTube 降级。
 * 扩展端在 MAIN world 跑，油猴端在页面上下文跑 —— 依赖只是「一个 window」。
 */
export async function runRemoteSources(options: {
  win: Window;
  ctx: HarvestContext;
}): Promise<SourceOutcome | null> {
  const { win, ctx } = options;
  const failures: FailureRecord[] = [];
  const fetchFn: FetchLike = (input, init) => win.fetch(input, init);
  const started = Date.now();

  const response = readPlayerResponse(win);
  const playability = describePlayability(response);

  // playerResponse 自带 videoDetails.videoId，可以精确判断它属于哪个视频。
  // SPA 切页后播放器可能还挂着上一个视频的响应，拿它取 captionTracks
  // 会拉到**上一页**的 timedtext —— 这正是「字幕总是慢一页」的来源之一。
  const declaredId = response?.videoDetails?.videoId;
  const staleResponse = Boolean(declaredId && declaredId !== ctx.videoId);
  const tracks = staleResponse ? [] : readCaptionTracks(response);

  if (staleResponse) {
    failures.push({
      source: 'player',
      code: 'NO_CAPTION_TRACK',
      ms: Date.now() - started,
      detail: `playerResponse 属于 ${declaredId}，不是当前 ${ctx.videoId}`,
    });
  } else if (playability) {
    failures.push({
      source: 'player',
      code: playability.code,
      ms: Date.now() - started,
      detail: playability.detail,
    });
  }

  const track = pickTrack(tracks, ctx.langs);
  if (track) {
    const attempt = await tryTrack(fetchFn, track, ctx.signal, 'player', ctx.tlang);
    failures.push(...attempt.failures);
    if (attempt.lines.length > 0) {
      return {
        lines: attempt.lines,
        source: 'player',
        track: attempt.track,
        showTimestamps: true,
        failures,
        complete: true,
      };
    }
  } else {
    failures.push({
      source: 'player',
      code: playability?.code ?? 'NO_CAPTION_TRACK',
      ms: Date.now() - started,
      detail: 'no captionTracks in playerResponse',
    });
  }

  if (ctx.signal.aborted) return null;

  // ④ InnerTube 探测（ANDROID → TVHTML5）
  const probeStarted = Date.now();
  const probe = await probeInnertube(win, ctx.videoId, ctx.signal, fetchFn);
  failures.push(...probe.failures);
  const probeTrack = pickTrack(probe.tracks, ctx.langs);
  if (!probeTrack) {
    if (probe.failures.length === 0) {
      failures.push({
        source: 'innertube',
        code: 'NO_CAPTION_TRACK',
        ms: Date.now() - probeStarted,
        detail: 'no captionTracks from InnerTube',
      });
    }
    return { lines: [], source: 'innertube', showTimestamps: true, failures };
  }

  const attempt = await tryTrack(fetchFn, probeTrack, ctx.signal, 'innertube', ctx.tlang);
  failures.push(...attempt.failures);
  if (attempt.lines.length === 0) {
    return { lines: [], source: 'innertube', showTimestamps: true, failures };
  }

  return {
    lines: attempt.lines,
    source: 'innertube',
    track: attempt.track,
    showTimestamps: true,
    failures,
    complete: true,
  };
}

/**
 * 不同接口的响应体格式不同：timedtext 是 xml/json3，get_transcript 是结构化 JSON。
 * 拦截层和 MAIN world 桥接层都要用这一份判断。
 */
export function linesFromCapture(capture: { kind: CaptureKind; text: string }): TranscriptLine[] {
  // get_panel（2026 面板）与 get_transcript 都是结构化 JSON，同一套解析
  return capture.kind === 'timedtext' ? parseTimedText(capture.text) : parseGetTranscript(capture.text);
}

/**
 * 从已捕获的响应里挑「最符合目标语言」的一条。
 *
 * 这是「手动切一次语言」方案的入口：用户在播放器里切一次字幕语言，YouTube 就会发
 * 一条带 POT 的 timedtext（签名绑定 (video, lang)，匿名可读）。这条捕获是我们
 * 拿到**非默认轨道**全文的唯一途径 —— `get_panel` 永远只给默认轨道。
 *
 * 以前这里只看「最新一条」：先切日语、再切回英语，日语那条就被顶掉了。
 * 现在的优先级：tlang 精确匹配 → langs 里任意一项 → 最新。
 */
export function pickCapture(
  captures: readonly TimedTextCapture[],
  ctx: Pick<HarvestContext, 'videoId' | 'langs' | 'tlang'>,
): TimedTextCapture | null {
  const mine = captures
    .filter((item) => item.videoId === ctx.videoId)
    .sort((a, b) => b.at - a.at);
  if (mine.length === 0) return null;
  if (!ctx.tlang) return mine[0];

  // 指定了产出语言时，只认「能验证语言」的 timedtext：
  // 面板捕获（get_panel）的 lang 是 null，它就是默认轨道，拿来顶等于给错语言。
  const timed = mine.filter((item) => item.kind === 'timedtext' && item.lang);
  const exact = timed.find((item) => langMatches(item.lang, ctx.tlang));
  return exact ?? timed[0] ?? mine[0];
}

/** 这条捕获能不能满足「指定的产出语言」。 */
function satisfiesLang(ctx: HarvestContext, capture: TimedTextCapture): boolean {
  if (!ctx.tlang) return true;
  if (capture.lang) return langMatches(capture.lang, ctx.tlang);
  // 语言未知的捕获只可能来自原生面板（get_panel），而面板永远返回**默认轨道**。
  // 所以只有「要的就是默认语言」时它才满足需求，否则就是把原文当译文。
  return langMatches(ctx.defaultLang ?? null, ctx.tlang);
}

/**
 * ① 被动拦截：等 YouTube 自己发出的字幕响应。
 * 可能是 timedtext（带 POT 的播放器请求），也可能是 get_panel（原生面板的数据）。
 */
export async function runInterceptSource(
  ctx: HarvestContext,
  hook: TimedTextHook | null,
  timeoutMs: number,
): Promise<SourceOutcome | null> {
  if (!hook) return null;
  let capture = pickCapture(hook.captures(), ctx);
  // 历史捕获里没有这个东西时问一下 hook（它会立刻返回最新的历史捕获）
  if (!capture) capture = await hook.waitFor(ctx.videoId, 0).catch(() => null);

  // 已有捕获但语言不对（用户想要中文，手上这条是英文）：等一会儿。
  // 我们在等待期间切一次 CC 语言的话，新的那条 timedtext 会立刻被挑中。
  if (timeoutMs > 0 && (!capture || !satisfiesLang(ctx, capture))) {
    const matched = hook.waitForMatch
      ? await hook
          .waitForMatch(ctx.videoId, (item) => satisfiesLang(ctx, item), timeoutMs)
          .catch(() => null)
      : await hook.waitFor(ctx.videoId, timeoutMs).catch(() => null);
    if (matched) capture = pickCapture(hook.captures(), ctx) ?? matched;
  }

  if (!capture) return null;

  // 捕获到的是原声轨道 / 语言未知：满足不了目标语言。
  // 放行就会「切成中文显示英文」，而且状态是 ready，用户完全看不出哪里不对。
  if (!satisfiesLang(ctx, capture)) {
    return {
      lines: [],
      source: 'intercept',
      showTimestamps: true,
      failures: [
        {
          source: 'intercept',
          code: 'NO_CAPTION_TRACK',
          ms: 0,
          detail: `捕获的是 ${capture.lang ?? '未知语言'}，不是要的 ${ctx.tlang}；在播放器里把字幕语言切成目标语言后再重试`,
        },
      ],
    };
  }

  const lines = linesFromCapture(capture);
  if (lines.length === 0) {
    // 「截到了但解析出 0 行」和「压根没截到」是两回事，必须分开报：
    // 前者说明响应结构变了（比如 *Renderer → *ViewModel），后者是时机问题。
    return {
      lines: [],
      source: 'intercept',
      showTimestamps: true,
      failures: [
        {
          source: 'intercept',
          code: 'EMPTY_200',
          ms: 0,
          detail: `截到了 ${capture.kind} 响应（${capture.text.length} 字符）但解析出 0 行`,
        },
      ],
    };
  }
  return {
    lines,
    source: 'intercept',
    showTimestamps: true,
    track: capture.lang
      ? { baseUrl: capture.url, languageCode: capture.lang }
      : undefined,
    // get_transcript / timedtext 都是一次返回全部分段，不是视口快照
    complete: true,
  };
}
