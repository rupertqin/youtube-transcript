import type { CaptionTrack, FailureRecord, HarvestContext, SourceOutcome, TranscriptLine } from '../types';
import type { CaptureKind, TimedTextHook } from './intercept';
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
}

/** 轨道逐格式尝试：json3 优先，空 200 / 解析失败再退 srv1。 */
async function tryTrack(
  fetchFn: FetchLike,
  track: CaptionTrack,
  signal: AbortSignal,
  source: 'player' | 'innertube',
): Promise<TrackAttempt> {
  const failures: FailureRecord[] = [];

  for (const fmt of ['json3', 'srv1'] as const) {
    const started = Date.now();
    const outcome = await fetchTimedText(fetchFn, track.baseUrl, fmt, signal);
    if (outcome.lines.length > 0) return { lines: outcome.lines, failures };
    failures.push({
      source,
      code: outcome.code ?? 'EMPTY_200',
      ms: Date.now() - started,
      detail: `${track.languageCode}/${fmt}: ${outcome.detail ?? '0 lines'}`,
    });
  }

  return { lines: [], failures };
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
  const tracks = readCaptionTracks(response);

  if (playability) {
    failures.push({
      source: 'player',
      code: playability.code,
      ms: Date.now() - started,
      detail: playability.detail,
    });
  }

  const track = pickTrack(tracks, ctx.langs);
  if (track) {
    const attempt = await tryTrack(fetchFn, track, ctx.signal, 'player');
    failures.push(...attempt.failures);
    if (attempt.lines.length > 0) {
      return { lines: attempt.lines, source: 'player', track, showTimestamps: true, failures };
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

  const attempt = await tryTrack(fetchFn, probeTrack, ctx.signal, 'innertube');
  failures.push(...attempt.failures);
  if (attempt.lines.length === 0) {
    return { lines: [], source: 'innertube', showTimestamps: true, failures };
  }

  return {
    lines: attempt.lines,
    source: 'innertube',
    track: probeTrack,
    showTimestamps: true,
    failures,
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
  const lines = linesFromCapture(capture);
  if (lines.length === 0) return null;
  return {
    lines,
    source: 'intercept',
    showTimestamps: true,
    track: capture.lang
      ? { baseUrl: capture.url, languageCode: capture.lang }
      : undefined,
  };
}
