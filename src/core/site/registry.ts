import type { SiteCapabilities, SiteId } from './types';

/**
 * 站点能力表。
 *
 * 放在注册表而不是 adapter 里，是因为 UI（尤其是扩展侧栏文档）拿到的是
 * `PanelState.site`，没有 adapter 实例 —— 它需要一份静态能力表来判断
 * 「这个站点有没有章节 / 机翻」，否则只能靠 if (site === 'bilibili') 到处写。
 */
export const SITE_CAPS: Record<SiteId, SiteCapabilities> = {
  youtube: {
    chapters: true,
    storyboard: true,
    machineTranslate: true,
    ccTrackSwitch: true,
  },
  bilibili: {
    chapters: false,
    storyboard: false,
    machineTranslate: false,
    ccTrackSwitch: false,
  },
};

export const SITE_IDS: SiteId[] = ['youtube', 'bilibili'];

const HOSTS: Record<SiteId, string[]> = {
  youtube: ['youtube.com', 'www.youtube.com', 'm.youtube.com'],
  bilibili: ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'],
};

/** host → 站点。未知站点返回 null（此时不注入任何入口）。 */
export function siteIdOf(url: URL | { hostname?: string }): SiteId | null {
  const host = (url.hostname ?? '').toLowerCase();
  for (const id of SITE_IDS) {
    if (HOSTS[id].some((known) => host === known || host.endsWith(`.${known}`))) return id;
  }
  return null;
}

/**
 * 按站点 id 取能力。
 *
 * 未知 / 空 id 时返回 YouTube 的能力（全开）—— 宁可多显示一个控件，
 * 也不能因为状态还没初始化就把章节、机翻按钮永久藏掉。
 */
export function capabilitiesOf(id: string | null | undefined): SiteCapabilities {
  if (id === 'bilibili') return SITE_CAPS.bilibili;
  return SITE_CAPS.youtube;
}
