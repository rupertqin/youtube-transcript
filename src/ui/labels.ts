import type { ErrorCode, SourceName } from '../core/types';

export const SOURCE_LABEL: Record<SourceName, string> = {
  player: '播放器',
  innertube: 'InnerTube',
  intercept: '拦截',
  dom: 'DOM',
};

/** B 站没有 InnerTube：同一层在那边是「官方接口」，标签换成用户看得懂的词。 */
const BILI_SOURCE_LABEL: Record<SourceName, string> = {
  player: '播放器',
  innertube: '接口',
  intercept: '拦截',
  dom: '页面',
};

/** 悬停说明：解释这一层是什么、什么时候会用到。 */
export const SOURCE_HINT: Record<SourceName, string> = {
  dom: 'DOM：直接读页面上原生字幕面板里的文字。最后一层，只能给视频原声语言，且需要面板先渲染出来。',
  player: '播放器：用播放器自带的字幕轨地址请求字幕。最快的一层。',
  innertube: 'InnerTube：播放器响应不可用时，改问站内接口重新取一遍轨道。',
  intercept: '拦截：站点自己请求字幕时顺手截获响应，不额外发请求。',
};

const BILI_SOURCE_HINT: Record<SourceName, string> = {
  dom: '页面：播放器已经加载的字幕轨（textTracks）。拿不到时说明 B 站是自绘字幕，只能走接口。',
  player: '播放器：用页面首屏数据里的字幕地址下载，不需要 WBI 签名。',
  innertube: '接口：WBI 签名的 player 接口，一次拿到全部字幕轨（投稿 / AI / 多语言）。',
  intercept: '拦截：页面自己请求字幕时顺手截获响应。',
};

export function sourceLabel(source: SourceName, site?: string | null): string {
  return (site === 'bilibili' ? BILI_SOURCE_LABEL : SOURCE_LABEL)[source] ?? source;
}

export function sourceHint(source: SourceName, site?: string | null): string {
  return (site === 'bilibili' ? BILI_SOURCE_HINT : SOURCE_HINT)[source] ?? '';
}

export const ERROR_COPY: Record<ErrorCode, { title: string; hint: string }> = {
  NO_CAPTION_TRACK: {
    title: '这个视频没有字幕轨道',
    hint: '可能作者没上传、未登录，或字幕仍在生成。换个视频或登录后重试。',
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
    title: '没能从原生面板读到字幕行',
    hint: '会自动切到 Transcript 标签并等字幕渲染。仍失败时可点底栏「诊断」查看卡在哪一层。',
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
    hint: '点重试会重新跑完整兜底链。',
  },
};

export const EMPTY_COPY = {
  title: '等待加载',
  hint: '打开一个带字幕的视频，面板会自动抓取。',
};

export const EMPTY_COPY_BILI = {
  title: '等待加载',
  hint: '打开一个 B 站视频页，面板会自动抓取字幕（需要登录才能读到字幕列表）。',
};

/** 按站点取空态文案：B 站要多说一句「需要登录」。 */
export function emptyCopy(site?: string | null): { title: string; hint: string } {
  return site === 'bilibili' ? EMPTY_COPY_BILI : EMPTY_COPY;
}

export function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
