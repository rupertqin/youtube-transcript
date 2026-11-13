import { stripA11yDuration } from './a11y';

/**
 * 内容指纹：判断「这份字幕是不是刚才那条视频的」。
 *
 * 为什么需要它：YouTube 站内跳转时**不会销毁已经展开的原生字幕面板**，
 * 面板里还留着上一条视频的行，而这些行不带任何视频标识。切页瞬间播放器
 * 已经切到新视频，所有基于 videoId 的校验都会放行 —— 于是新视频配上
 * 上一条视频的字幕，id 完全对得上，怎么查都查不出来。
 *
 * 唯一可靠的判据是**内容本身**：与切换前完全一致，就只能是那份旧内容。
 *
 * 归一化必须与展示路径一致（同样洗掉无障碍时长、同样忽略大小写与空白），
 * 否则两条路径算出来的指纹不同，守卫就会静默失效。
 */

/** 计算指纹只需要「起点 + 正文」两个字段。 */
export interface SignatureLine {
  start: number;
  text: string;
}

/** FNV-1a 32 位：足够快（一次遍历、无分配），也足够稳 —— 这里只用来判「是不是同一份」。 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const WHITESPACE = /\s+/gu;

/**
 * 只保留「用户看得见的字」：洗掉无障碍时长、压掉所有空白、统一小写。
 *
 * 不看时间码：快照文本与结构化行的时间码来源不同（一个在行首、一个在 start
 * 字段），把它们剔除后两条路径才会得到同一串字符。
 */
function squash(lines: readonly SignatureLine[]): string {
  let out = '';
  for (const line of lines) {
    out += stripA11yDuration(line.text, line.start).replace(WHITESPACE, '').toLowerCase();
  }
  return out;
}

/**
 * 一组行的内容指纹；空内容返回空串（调用方按「没有指纹」处理）。
 *
 * 传 `start` 是必要的：结构化行的时间码已经抽到 start 字段，
 * 正文里只剩「33 minutes, 26 seconds」这种复述，缺了 start 就洗不掉。
 */
export function contentSignature(lines: readonly SignatureLine[]): string {
  if (lines.length === 0) return '';
  const bundled = squash(lines);
  return bundled.length > 0 ? fnv1a(bundled) : '';
}
