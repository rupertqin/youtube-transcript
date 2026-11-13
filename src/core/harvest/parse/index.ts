import type { LineFormat, TranscriptLine } from '../../types';
import { parseJson3 } from './json3';
import { parseSrv } from './srv';
import { parseVtt } from './vtt';

/** timedtext 的 fmt 不由请求参数保证（拦截到的响应可能是任意格式），统一嗅探。 */
export function detectFormat(raw: string): LineFormat {
  const head = raw.replace(/^\uFEFF/u, '').trimStart().slice(0, 64);
  if (head.startsWith('{') || head.startsWith('[')) return 'json3';
  if (/^WEBVTT/iu.test(head)) return 'vtt';
  if (head.includes('-->')) return 'vtt';
  return 'srv';
}

/**
 * YouTube 的「异常流量 / 人机校验」拦截页。
 *
 * 它是 **HTTP 200 + HTML**，不是字幕。以前没有这道判断，`parseSrv` 的 `<p>`
 * 兜底会把那段提示整段当成「一条字幕」，界面上就出现一句
 * 「…your computer or network may be sending automated queries…」，
 * 而且状态还是 ready，无法与真的字幕区分。
 */
const BLOCK_HINTS = [
  'unusual traffic',
  'automated queries',
  "can't process your request",
  '<!doctype html',
  '<html',
];

export function isBlockedPayload(raw: string): boolean {
  const head = raw.slice(0, 4096).toLowerCase();
  return BLOCK_HINTS.some((hint) => head.includes(hint));
}

export function parseTimedText(raw: string): TranscriptLine[] {
  const body = raw.replace(/^\uFEFF/u, '');
  if (!body.trim()) return [];
  if (isBlockedPayload(body)) return [];

  const format = detectFormat(body);
  if (format === 'json3') {
    // 必须是真 json3：整页 HTML 也可能以 { 开头，不能只靠首字符
    return body.includes('"events"') ? parseJson3(body) : [];
  }
  if (format === 'vtt') return parseVtt(body);
  // srv 必须真的带字幕标签：否则任意 HTML 都会被 <p> 规则吃成一行
  return /<transcript\b|<timedtext\b/im.test(body) ? parseSrv(body) : [];
}

export { parseJson3, parseSrv, parseVtt };
