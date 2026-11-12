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

export function parseTimedText(raw: string): TranscriptLine[] {
  const body = raw.replace(/^\uFEFF/u, '');
  if (!body.trim()) return [];
  const format = detectFormat(body);
  if (format === 'json3') return parseJson3(body);
  if (format === 'vtt') return parseVtt(body);
  return parseSrv(body);
}

export { parseJson3, parseSrv, parseVtt };
