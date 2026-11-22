import type { ErrorCode } from '../../types';

/**
 * B 站错误码 → 面板错误码 + 一句能照着做的话。
 *
 * 这几个码很值得单独映射，因为它们对应的处理方式完全不同：
 * `-101` 是没登录（去登录）、`-352` 是被风控（等一会儿）、空列表是没字幕
 * （AI 可能还在生成）。全都报成「网络错误」等于什么都没说。
 */
export function biliError(code: number | undefined, message?: string): {
  code: ErrorCode;
  detail: string;
} {
  const suffix = message ? `（${message}）` : '';
  switch (code) {
    case -101:
      return {
        code: 'NO_CAPTION_TRACK',
        detail: `B 站要求登录才能读字幕列表${suffix}：请先在 bilibili.com 登录，再点重试`,
      };
    case -352:
      return {
        code: 'RATE_LIMITED',
        detail: `触发了 B 站风控${suffix}：等一会儿再重试，别连续点`,
      };
    case -403:
      return {
        code: 'AGE_RESTRICTED',
        detail: `这个视频的字幕需要更高权限${suffix}`,
      };
    case 404:
    case -404:
    case -400:
      return {
        code: 'NO_CAPTION_TRACK',
        detail: `B 站接口不认识这个视频/分 P${suffix}`,
      };
    default:
      return {
        code: 'UNKNOWN',
        detail: `B 站接口错误 ${code ?? '未知'}${suffix}`,
      };
  }
}

/** 登录态拿得到、但这个视频确实没有字幕轨。 */
export function noSubtitleDetail(): string {
  return (
    '这个视频没有可用的字幕轨。可能原因：' +
    '① 未登录（B 站对匿名请求不返回字幕列表）；' +
    '② 视频刚发布，AI 字幕仍在生成；' +
    '③ UP 主关闭了字幕'
  );
}
