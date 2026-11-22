import type { SiteAdapter, SiteCapabilities, SiteHarvestInput } from '../src/core/site/types';
import type { Chapter, HarvestResult } from '../src/core/types';

export interface FakeSiteOptions {
  id?: 'youtube' | 'bilibili';
  /** 从地址栏解析视频 id；缺省按 `?v=` 解析 */
  videoId?: (location: { href: string }) => string | null;
  title?: (videoId: string) => string;
  duration?: number | null;
  /** 播放器此刻在播哪个视频（写缓存/章节的归属守卫）；null = 取不到，放行 */
  playerVideoId?: () => string | null;
  langs?: string[];
  chapters?: Chapter[];
  harvest?: (input: SiteHarvestInput) => Promise<HarvestResult>;
  capabilities?: Partial<SiteCapabilities>;
}

const noopHandle = {
  ensureMounted: () => true,
  show: () => true,
  hide: () => undefined,
  toggle: () => true,
  isOpen: () => false,
  destroy: () => undefined,
};

/**
 * 一个「什么都不会碰 DOM」的站点实现。
 *
 * 会话层测试用它来证明一件事：session 只需要 SiteAdapter 就能工作，
 * 不再偷偷去读 YouTube 的 `#movie_player`。
 */
export function createFakeSite(options: FakeSiteOptions = {}): SiteAdapter {
  const id = options.id ?? 'youtube';
  const videoIdOf =
    options.videoId ?? ((location: { href: string }) => new URL(location.href).searchParams.get('v'));

  return {
    id,
    // 默认全开，避免测试因为「能力表默认值」这种无关原因挂掉
    capabilities: {
      chapters: true,
      storyboard: true,
      machineTranslate: true,
      ccTrackSwitch: true,
      ...options.capabilities,
    },
    cacheNamespace: id,
    entryLabel: 'Transcript',
    match: () => true,
    videoIdOf,
    // 归属守卫：null = 取不到播放器 id，session 会放行（与真实站点的降级一致）
    playerVideoId: options.playerVideoId ?? (() => null),
    title: options.title ?? ((videoId: string) => `title-${videoId}`),
    duration: () => options.duration ?? null,
    chapters: () => options.chapters ?? [],
    storyboard: async () => null,
    availableLangs: () => options.langs ?? [],
    langPlan: () => ({ langs: options.langs ?? [], tlang: null }),
    choice: () => 'auto',
    harvest:
      options.harvest ??
      (async (input) => ({
        lines: [{ start: 0, dur: 0, text: `line of ${input.videoId}` }],
        source: 'dom',
        showTimestamps: true,
        failures: [],
      })),
    mount: () => noopHandle,
    diagnostic: () => null,
  };
}
