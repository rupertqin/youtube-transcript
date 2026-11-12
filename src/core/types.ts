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
  showTimestamps: boolean;
  source: SourceName | null;
  lang: string | null;
  cached: boolean;
  failures: FailureRecord[];
  error: { code: ErrorCode; detail?: string } | null;
  activeIndex: number;
  updatedAt: number;
  /** 抓取阶段的临时提示（如「正在打开原生面板」），就绪后清空 */
  progress?: string | null;
}

export type ExportFormat = 'txt' | 'md' | 'srt' | 'json';
