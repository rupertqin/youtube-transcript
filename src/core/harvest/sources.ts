import type { CaptionTrack, FailureRecord, HarvestContext, SourceOutcome, TranscriptLine } from '../types';
import type { CaptureKind, TimedTextHook } from './intercept';
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
  return capture.kind === 'get_transcript' ? parseGetTranscript(capture.text) : parseTimedText(capture.text);
}

/**
 * ① 被动拦截：等 YouTube 自己发出的字幕响应。
 * 可能是 timedtext（带 POT 的播放器请求），也可能是 get_transcript（原生面板的数据）。
 */
export async function runInterceptSource(
  ctx: HarvestContext,
  hook: TimedTextHook | null,
  timeoutMs: number,
): Promise<SourceOutcome | null> {
  if (!hook) return null;
  const capture = await hook.waitFor(ctx.videoId, timeoutMs);
  if (!capture) return null;

  // 请求了翻译、但捕获到的是原声轨道：它满足不了目标语言。
  // 放行就会「切成中文显示英文」，而且状态是 ready，用户完全看不出哪里不对。
  if (ctx.tlang && !langMatches(capture.lang, ctx.tlang)) {
    return {
      lines: [],
      source: 'intercept',
      showTimestamps: true,
      failures: [
        {
          source: 'intercept',
          code: 'NO_CAPTION_TRACK',
          ms: 0,
          detail: `捕获的是 ${capture.lang ?? '未知语言'}，不是要的 ${ctx.tlang}`,
        },
      ],
    };
  }

  const lines = linesFromCapture(capture);
  if (lines.length === 0) return null;
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
