import type { ErrorCode, SourceName } from '../core/types';

export const SOURCE_LABEL: Record<SourceName, string> = {
  player: '播放器',
  innertube: 'InnerTube',
  intercept: '拦截',
  dom: 'DOM',
};

export const ERROR_COPY: Record<ErrorCode, { title: string; hint: string }> = {
  NO_CAPTION_TRACK: {
    title: '这个视频没有字幕轨道',
    hint: '可能作者没上传，或播放器未启用字幕。换个视频试试。',
  },
  EMPTY_200: {
    title: '字幕请求返回空内容',
    hint: 'YouTube 的 proof-origin token（POT）在拦。先手动打开一次原生字幕面板再重试。',
  },
  POT_ENFORCED: {
    title: '字幕接口被 token 校验拦截',
    hint: '这是服务端签名策略导致的。重试会走被动拦截层，通常能拿到播放器自己的请求结果。',
  },
  SELECTOR_MISS: {
    title: '页面结构已变化',
    hint: 'YouTube 改了 DOM。选择器可以在设置里远程覆盖，或等插件更新。',
  },
  RATE_LIMITED: {
    title: '请求过于频繁',
    hint: '等几十秒再试。已抓到的字幕会缓存 7 天，不会重复请求。',
  },
  AGE_RESTRICTED: {
    title: '视频需要登录或年龄验证',
    hint: '先在浏览器里登录并确认年龄，再回到这个页面重试。',
  },
  NETWORK_ERROR: {
    title: '网络异常',
    hint: '检查代理或网络后重试。抓取链路每一层都已记录，可在诊断里查看。',
  },
  UNKNOWN: {
    title: '没抓到字幕',
    hint: '点重试会重新跑完整兜底链（播放器 → InnerTube → 拦截 → DOM）。',
  },
};

export const EMPTY_COPY = {
  title: '等待加载',
  hint: '打开一个带字幕的 YouTube 视频，面板会自动抓取。',
};

export function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
