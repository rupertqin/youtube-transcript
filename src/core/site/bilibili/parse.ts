import type { CaptionTrack, TranscriptLine } from '../../types';

/** `x/player/wbi/v2` 的 `subtitle.subtitles[]` 条目（只留用得到的字段）。 */
export interface BiliTrack {
  id?: number;
  /** 轨道语言码：`zh-CN` / `ai-zh` / `en-US` … */
  lan: string;
  /** 人类可读名字：`中文（中国）` / `中文（自动生成）` */
  lan_doc?: string;
  /** 字幕体地址；AI 字幕生成中时可能是空串 */
  subtitle_url?: string;
  /** 0 = 投稿（人工）字幕，其余 = AI */
  type?: number;
  ai_status?: number;
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

export function normalizeTrack(track: BiliTrack): CaptionTrack & { doc: string; ai: boolean } {
  const ai = track.type !== 0;
  const url = track.subtitle_url ?? '';
  return {
    baseUrl: url.startsWith('//') ? `https:${url}` : url,
    languageCode: normalizeLang(track.lan),
    // 人工轨（type 0）优先：断句更规整，也没有「生成中」这种中间态
    kind: ai ? 'asr' : 'manual',
    name: track.lan_doc ?? track.lan,
    doc: track.lan_doc ?? track.lan,
    ai,
  };
}

/** 默认挑哪条：人工 > 中文 > AI，其余按接口顺序。 */
export function trackScore(track: BiliTrack): number {
  let score = 0;
  if (track.type === 0) score += 60;
  const lang = normalizeLang(track.lan);
  if (lang.startsWith('zh')) score += 100;
  if (lang.startsWith('en')) score += 20;
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
