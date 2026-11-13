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
}

export interface HarvestContext {
  videoId: string;
  langs: string[];
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
  cached: boolean;
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
