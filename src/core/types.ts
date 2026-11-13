/** 字幕抓取/渲染共用的领域类型。这里不允许出现平台 API（chrome.* / React）。 */

export type ErrorCode =
  | 'NO_CAPTION_TRACK'
  | 'EMPTY_200'
  | 'POT_ENFORCED'
  | 'SELECTOR_MISS'
  | 'RATE_LIMITED'
  | 'AGE_RESTRICTED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export type SourceName = 'player' | 'innertube' | 'intercept' | 'dom';

export type LineFormat = 'json3' | 'srv' | 'vtt';

/** 单行字幕，时间统一用毫秒，渲染层再做格式化。 */
export interface TranscriptLine {
  start: number;
  dur: number;
  text: string;
}

/** 章节与字幕行同构（起点 + 标题），但独立存放，绝不混进 lines。 */
export type Chapter = TranscriptLine;

/** 面板当前展示/复制的内容视图，两个入口共用。 */
export type ContentView = 'lines' | 'chapters';

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  /** 'asr' 表示自动生成轨道 */
  kind?: string;
  name?: string;
  vssId?: string;
  isTranslatable?: boolean;
}

export interface FailureRecord {
  source: SourceName | 'cache';
  code: ErrorCode;
  ms: number;
  detail?: string;
}

export interface LogEvent {
  at: number;
  code: ErrorCode | 'OK';
  source?: SourceName | 'cache' | 'host';
  ms?: number;
  detail?: string;
  meta?: Record<string, unknown>;
}

export type Logger = (event: Omit<LogEvent, 'at'>) => void;

/** 某一层抓取成功的产出；失败时由 chain 记 FailureRecord。 */
export interface SourceOutcome {
  lines: TranscriptLine[];
  source: SourceName;
  track?: CaptionTrack;
  showTimestamps: boolean;
  failures?: FailureRecord[];
  /**
   * 是否是「从开头到结尾的完整字幕」。
   *
   * false = 只从页面上已渲染的视口里读到的片段（DOM 预览），
   * 可以临时显示但**不能当最终结果、不能写缓存**。
   * 省略按 true 处理：结构化接口、拦截、远程都是全量结果。
   */
  complete?: boolean;
}

export interface HarvestContext {
  videoId: string;
  langs: string[];
  /**
   * 需要机器翻译成的语言（timedtext 的 tlang 参数）。null/省略 = 用原声轨道。
   * 只在「视频没有该语言的原生字幕」时才会真正拼进 URL。
   */
  tlang?: string | null;
  signal: AbortSignal;
  log: Logger;
}

export interface HarvestResult extends SourceOutcome {
  failures: FailureRecord[];
}

export interface PanelState {
  videoId: string;
  title: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  lines: TranscriptLine[];
  /** storyboard 规格串：章节行据此裁出该时间点的画面 */
  storyboard: string | null;
  /** 章节独立存放：不能被 looksLikeTranscript 判成字幕，也不混进 lines */
  chapters: Chapter[];
  showTimestamps: boolean;
  source: SourceName | null;
  lang: string | null;
  /**
   * 这条视频「能拿到哪些语言」的字幕：原生轨道 + YouTube 支持的机器翻译目标。
   * 语言切换按钮只显示这里列出的语言 —— 没有的字幕就不要给一个点了没反应的按钮。
   */
  availableLangs: string[];
  cached: boolean;
  /** false = 当前显示的是临时预览，完整结果还在路上 */
  complete: boolean;
  failures: FailureRecord[];
  error: { code: ErrorCode; detail?: string } | null;
  /** 当前高亮行（字幕视图用），-1 表示无 */
  activeIndex: number;
  /**
   * 真实播放位置（毫秒），-1 表示未知。
   * 章节高亮必须用它 —— activeIndex 指向的是「字幕行的 start」，
   * 那个时间点必然早于章节起点，拿它算章节会永远高亮上一章。
   */
  positionMs: number;
  updatedAt: number;
  /** 抓取阶段的临时提示（如「正在打开原生面板」），就绪后清空 */
  progress?: string | null;
  /** DOM 抓取失败时的面板结构快照，直接显示在错误卡片里 */
  diagnostic?: string | null;
}

export type ExportFormat = 'txt' | 'md' | 'srt' | 'json';
