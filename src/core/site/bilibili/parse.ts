import type { CaptionTrack, TranscriptLine } from '../../types';

/** 字幕来源：人工投稿 / AI 生成 / 字段不全无法判断。 */
export type BiliTrackSource = 'human' | 'ai' | 'unknown';

/** `x/player/wbi/v2` 的 `subtitle.subtitles[]` 条目（只留用得到的字段）。 */
export interface BiliTrack {
  id?: number;
  id_str?: string;
  /** 轨道语言码：`zh-CN` / `ai-zh` / `en-US` … */
  lan: string;
  /** 人类可读名字：`中文（中国）` / `中文（自动生成）` */
  lan_doc?: string;
  /** 字幕体地址；AI 字幕生成中时可能是空串 */
  subtitle_url?: string;
  /** 0 = 投稿（人工）字幕，1 = AI；字段可能缺失 */
  type?: number;
  ai_status?: number;
  ai_type?: number;
  is_ai?: boolean | string | number;
  is_ai_subtitle?: boolean | string | number;
  is_machine?: boolean | string | number;
  /** 已判定过的来源（避免重复推断） */
  source?: BiliTrackSource;
  /** 从 `view` 接口的 `subtitle.list` 补来的同轨道信息 */
  source_hint?: BiliTrack;
}

/** 地址栏 → `{ bvid, page }`；分 P 用 `?p=`，缺省第 1 P。 */
export function parseBiliVideoId(href: string): { bvid: string; page: number } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const bvid = /(BV[0-9A-Za-z]{10})/.exec(url.pathname)?.[1];
  if (!bvid) return null;
  const raw = Number(url.searchParams.get('p'));
  const page = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  return { bvid, page };
}

/**
 * 视频在缓存/状态里的标识。
 *
 * 必须带分 P：同一 BV 的第 2 P 是另一段音视频、另一套字幕，
 * 只用 bvid 会让第 2 P 命中第 1 P 的缓存。
 */
export function biliVideoKey(bvid: string, page: number): string {
  return page > 1 ? `${bvid}:p${page}` : bvid;
}

/** 反向解析 `BV1xx:p2`。 */
export function splitBiliVideoKey(videoId: string): { bvid: string; page: number } | null {
  const match = /^(BV[0-9A-Za-z]{10})(?::p(\d+))?$/.exec(videoId);
  if (!match) return null;
  return { bvid: match[1], page: match[2] ? Number(match[2]) : 1 };
}

/**
 * 站点语言码 → 通用语言码。
 *
 * `ai-zh` 是「AI 生成的中文」，对用户就是中文；归一化后 UI 的
 * 「中 / EN」判断与缓存的语言匹配都不用再认识 B 站私有码。
 */
export function normalizeLang(lan: string): string {
  const code = lan.toLowerCase();
  if (code === 'ai-zh' || code === 'zh-cn' || code === 'zh-hans') return 'zh-Hans';
  if (code === 'zh-tw' || code === 'zh-hk' || code === 'zh-hant') return 'zh-Hant';
  if (code.startsWith('ai-')) {
    const base = code.slice(3);
    return base.split('-')[0];
  }
  return code;
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const n = numeric(value);
  if (n === 0 || n === 1) return n === 1;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === 'yes') return true;
    if (text === 'false' || text === 'no') return false;
  }
  return null;
}

function detectSource(track: BiliTrack, depth: number): BiliTrackSource {
  if (track.source === 'human' || track.source === 'ai' || track.source === 'unknown') return track.source;

  const type = numeric(track.type);
  if (type === 1) return 'ai';
  if (type === 0) return 'human';
  if ((numeric(track.ai_status) ?? 0) > 0 || (numeric(track.ai_type) ?? 0) > 0) return 'ai';
  if ((track.lan ?? '').toLowerCase().startsWith('ai-')) return 'ai';

  const url = (track.subtitle_url ?? '').toLowerCase();
  if (['aisubtitle.hdslb.com', '/ai_subtitle/', '/aisubtitle/'].some((key) => url.includes(key))) return 'ai';

  const signals = [track.is_ai, track.is_ai_subtitle, track.is_machine]
    .map(boolLike)
    .filter((value): value is boolean => value !== null);
  if (signals.includes(true)) return 'ai';
  if (signals.length > 0 && signals.every((value) => value === false)) return 'human';

  // 本轨道字段不全时，借用 view 接口里同一条轨道的字段
  if (track.source_hint && depth === 0) return detectSource(track.source_hint, 1);
  return 'unknown';
}

/** 综合 type / lan / URL / 布尔字段判断投稿还是 AI，判断不出就是 unknown。 */
export function trackSource(track: BiliTrack): BiliTrackSource {
  return detectSource(track, 0);
}

function hintKeys(track: BiliTrack): string[] {
  const keys: string[] = [];
  if (track.id_str) keys.push(`id_str:${track.id_str}`);
  if (track.id !== undefined) keys.push(`id:${track.id}`);
  if (track.subtitle_url) keys.push(`url:${track.subtitle_url.replace(/^https?:\/\//u, '')}`);
  keys.push(`lan_type:${track.lan}|${String(track.type)}`);
  keys.push(`lan:${track.lan}`);
  return keys;
}

/**
 * 用 `view` 接口的 `subtitle.list` 给 `player/wbi/v2` 的轨道补来源线索。
 * 两个接口同一条轨道的 id/url 未必一致，所以按多个键交叉匹配。
 */
export function withSourceHints(
  tracks: readonly BiliTrack[],
  hints: readonly BiliTrack[],
): BiliTrack[] {
  const index = new Map<string, BiliTrack>();
  for (const hint of hints) {
    for (const key of hintKeys(hint)) if (!index.has(key)) index.set(key, hint);
  }
  return tracks.map((track) => {
    const hint = hintKeys(track).map((key) => index.get(key)).find(Boolean) ?? null;
    const merged = hint && hint !== track ? { ...track, source_hint: hint } : track;
    return { ...merged, source: trackSource(merged) };
  });
}

/** 下拉/诊断用的轨道名：`中文（中国）（人工）`，不重复堆叠来源词。 */
export function trackDisplayName(track: BiliTrack): string {
  const language = track.lan_doc || track.lan || '未知语言';
  const source = trackSource(track);
  const label = source === 'human' ? '人工' : source === 'ai' ? 'AI' : '未知';
  return `${language}（${label}）`;
}

export function normalizeTrack(track: BiliTrack): CaptionTrack & { doc: string; ai: boolean } {
  const ai = trackSource(track) === 'ai';
  const url = track.subtitle_url ?? '';
  return {
    baseUrl: url.startsWith('//') ? `https:${url}` : url,
    languageCode: normalizeLang(track.lan),
    // 人工轨断句更规整，也没有「生成中」这种中间态
    kind: ai ? 'asr' : 'manual',
    name: trackDisplayName(track),
    doc: track.lan_doc ?? track.lan,
    ai,
  };
}

/**
 * 默认挑哪条：人工中文 > 人工任意 > 未知来源中文 > 未知 > AI 中文 > AI。
 * 同一档内保持接口顺序（stable sort）。
 */
export function trackScore(track: BiliTrack): number {
  const source = trackSource(track);
  let score = source === 'human' ? 140 : source === 'unknown' ? 90 : 40;
  const lang = normalizeLang(track.lan);
  if (lang.startsWith('zh')) score += 100;
  else if (lang.startsWith('en')) score += 20;
  if (!track.subtitle_url) score -= 50;
  return score;
}

/**
 * 挑一条轨道。
 *
 * 用户在面板上选了中文 / English 时，优先给对应语言；该视频没有该语言时
 * 仍返回最高分那条（B 站没有机翻，不能假装能给另一种语言）。
 */
export function pickBiliTrack(
  tracks: readonly BiliTrack[],
  preferred: 'auto' | 'zh' | 'en' = 'auto',
): BiliTrack | null {
  const usable = tracks.filter((track) => Boolean(track.subtitle_url));
  if (usable.length === 0) return null;
  const sorted = [...usable].sort((a, b) => trackScore(b) - trackScore(a));
  if (preferred === 'auto') return sorted[0];
  const wanted = preferred === 'zh' ? 'zh' : 'en';
  return sorted.find((track) => normalizeLang(track.lan).startsWith(wanted)) ?? sorted[0];
}

/** `{ body: [{ from, to, content }] }` → 行；时间是**秒**，这里换成毫秒。 */
export function parseSubtitleBody(raw: unknown): TranscriptLine[] {
  const body = (raw as { body?: unknown })?.body;
  if (!Array.isArray(body)) return [];
  const lines: TranscriptLine[] = [];
  for (const item of body as Array<{ from?: number; to?: number; content?: string }>) {
    const text = String(item?.content ?? '')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const from = Number(item?.from);
    const to = Number(item?.to);
    const start = Number.isFinite(from) ? Math.max(0, Math.round(from * 1000)) : 0;
    const end = Number.isFinite(to) ? Math.round(to * 1000) : start;
    lines.push({ start, dur: Math.max(0, end - start), text });
  }
  return lines;
}
