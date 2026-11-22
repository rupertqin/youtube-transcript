import type { TimedTextHook } from '../harvest/intercept';
import type { LangChoice } from '../langs';
import type { Logger } from '../types';
import { createBilibiliSite } from './bilibili';
import type { BiliPageSnapshot } from './bilibili/page-state';
import { siteIdOf } from './registry';
import type { SiteAdapter } from './types';
import { createYouTubeSite, type SiteBridge } from './youtube';

export interface CreateSiteOptions {
  win: Window;
  doc: Document;
  log: Logger;
  /** 扩展端：MAIN world 桥；油猴端不传（同进程直连） */
  bridge?: SiteBridge | null;
  ensureBridge?: () => Promise<boolean>;
  /** 油猴端：同进程的 timedtext hook（扩展端它在 MAIN world，走 bridge） */
  hook?: TimedTextHook | null;
  /** B 站页面首屏状态（扩展端经桥取，油猴端直接读） */
  readPageState?: () => Promise<BiliPageSnapshot | null>;
  /** 用户语言偏好 */
  readChoice?: () => LangChoice;
  /** YouTube A 方案开关 */
  autoSwitchTrack?: () => boolean;
}

/**
 * 按当前 host 造站点适配器。
 *
 * 不在支持的站点上就返回 null —— 入口据此决定「不注入任何按钮」。
 */
export function createSite(options: CreateSiteOptions): SiteAdapter | null {
  const id = siteIdOf(options.win.location);
  if (id === 'youtube') {
    return createYouTubeSite({
      win: options.win,
      doc: options.doc,
      log: options.log,
      bridge: options.bridge ?? null,
      ensureBridge: options.ensureBridge,
      hook: options.hook ?? null,
      readChoice: options.readChoice,
      autoSwitchTrack: options.autoSwitchTrack,
    });
  }
  if (id === 'bilibili') {
    return createBilibiliSite({
      win: options.win,
      doc: options.doc,
      log: options.log,
      readChoice: options.readChoice,
      readPageState: options.readPageState,
    });
  }
  return null;
}
