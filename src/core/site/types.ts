import type { LangChoice, LangPlan } from '../langs';
import type { Chapter, HarvestResult, Logger, PanelState, TranscriptLine } from '../types';

/**
 * 站点契约。
 *
 * 这一层存在的唯一理由：`platform/session.ts`（切页对账、缓存、播放跟随）与
 * `ui/*` 不该知道 YouTube 的 `#movie_player`、也不该知道 B 站的 WBI 签名。
 * 站点差异全部收敛到 `SiteAdapter` 的实现里，session 只按接口调用。
 */

/** 站点能力。UI 据此隐藏「点了也没用」的控件，而不是给假按钮。 */
export interface SiteCapabilities {
  /** 有章节（含章节缩略图） */
  chapters: boolean;
  /** 有 storyboard 雪碧图 */
  storyboard: boolean;
  /** 支持 tlang 机器翻译（B 站只有原生轨道，没有机翻） */
  machineTranslate: boolean;
  /** 会主动切 CC 轨道去截 timedtext（B 站没有这个通路） */
  ccTrackSwitch: boolean;
}

export type SiteId = 'youtube' | 'bilibili';

/** UI 只依赖这四个方法；`platform/types.ts` 的 TranscriptClient 就是它。 */
export interface SiteClient {
  getState(): PanelState;
  subscribe(listener: (state: PanelState) => void): () => void;
  load(force?: boolean): Promise<void>;
  seek(seconds: number): void;
}

export interface SiteHarvestOptions {
  /** 刚刚切页：DOM 层不能直接拿「现有文字」 */
  staleRisk?: boolean;
  /** 切换前那条视频的内容指纹 */
  avoid?: string | null;
  /** 同步预览回传（只临时显示，不写缓存） */
  onPreview?: (lines: TranscriptLine[]) => void;
}

export interface SiteHarvestInput {
  videoId: string;
  signal: AbortSignal;
  onStage: (stage: string) => void;
  options?: SiteHarvestOptions;
}

export interface SiteMountInput {
  doc: Document;
  /** 面板样式表（构建期 `?inline` 进来的同一份 CSS） */
  css: string;
  client: SiteClient;
  /** 地址栏当前视频 id，用于「可见即正确」的闸门 */
  currentVideoId: () => string | null;
}

/** 入口按钮 + 面板的组合句柄；两个站点各自实现挂载方式。 */
export interface SitePanelHandle {
  /** 确保宿主还在文档里（SPA 重建/切页后调用） */
  ensureMounted(): boolean;
  show(): boolean;
  hide(): void;
  toggle(): boolean;
  isOpen(): boolean;
  destroy(): void;
}

/** 站点实现拿到的宿主环境。扩展端与油猴端的差异只在注入的 runtime 上。 */
export interface SiteDeps {
  win: Window;
  doc: Document;
  log: Logger;
}

export interface SiteAdapter {
  readonly id: SiteId;
  readonly capabilities: SiteCapabilities;
  /** 缓存命名空间：两站的 videoId 格式不同，绝不能让它们命中彼此 */
  readonly cacheNamespace: string;
  /** 入口按钮文案 */
  readonly entryLabel: string;

  /** 这个 URL 是不是本站点的视频页 */
  match(url: URL): boolean;
  /** 地址栏 → 视频 id（B 站带分 P：`BV1xx:p2`） */
  videoIdOf(location: { href: string }): string | null;
  /** 视频 id → 站点原生地址；导出元数据不能再硬编码某个站点 */
  url(videoId: string): string | null;
  /** 播放器此刻在播哪个视频：缓存写入的归属守卫 */
  playerVideoId(): string | null;
  title(videoId: string): string;
  duration(videoId: string): number | null;
  /** 页面上的章节（B 站没有，返回空数组） */
  chapters(): Chapter[];
  storyboard(videoId: string): Promise<string | null>;
  /** 已归一化的可用字幕语言（`ai-zh` 归到 `zh-Hans`） */
  availableLangs(videoId: string): string[];
  /** 用户偏好 → 本次抓取的语言方案（同步版，给 UI 用；轨道表没读到时不降级） */
  langPlan(): LangPlan;
  /**
   * 同上，但**先等语言表到手**再算。
   *
   * 读不到轨道信息的视频不能按「同音频」降级，也不能凭空相信用户的选择 ——
   * 抓取与缓存读取都必须用同一份 plan，否则会出现「面板写着中文、缓存放的是英文」。
   * 没实现时退回 `langPlan()`（B 站轨道来自接口，自己会等）。
   */
  resolvePlan?(videoId: string): Promise<LangPlan>;
  /** 当前语言选择（UI 高亮用；拿不到可用轨道时按 auto 处理） */
  choice(videoId: string): LangChoice;

  harvest(input: SiteHarvestInput): Promise<HarvestResult>;

  /** 收起页面残留的原生字幕面板（YouTube 有，B 站没有） */
  closeNativePanel?(): Promise<unknown>;
  /** 挂载入口按钮 + 面板（右栏卡片 / 右下浮层） */
  mount(input: SiteMountInput): SitePanelHandle;
  /** 出错时附在诊断里的站点信息 */
  diagnostic(): string | null;
  /** 换台时清掉站内的短期缓存（轨道列表 / WBI key 之外的东西） */
  onNavigate?(videoId: string | null): void;
}
