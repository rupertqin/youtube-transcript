import panelCss from '../src/ui/styles.css?inline';
import { installShadowCapture } from '../src/core/dom/shadow';
import { installTimedTextHook } from '../src/core/harvest/intercept';
import { log } from '../src/core/log';
import { readBiliPageState } from '../src/core/site/bilibili/page-state';
import { createSite } from '../src/core/site/create';
import { siteIdOf } from '../src/core/site/registry';
import { createLocalClient } from '../src/platform/client.in-process';
import { createSession } from '../src/platform/session';
import { getPrefs } from '../src/ui/prefs';

/**
 * 油猴入口：`@grant none` 让脚本本身就跑在页面上下文，
 * 所以不需要 MAIN/ISOLATED 消息桥 —— 站点适配器里那两条通路（直连 / 过桥）
 * 会自动走「直连」分支。
 *
 * 站点差异全部在 `createSite` 之后：这里既不知道 YouTube 的 `#movie_player`，
 * 也不知道 B 站的 WBI。
 */
(() => {
  'use strict';

  const win = window;
  // 不认识的站点：一个按钮都不注入
  const siteId = siteIdOf(win.location);
  if (!siteId) return;

  if (siteId === 'youtube') {
    installShadowCapture(window);
  }
  // timedtext 的 fetch/XHR hook 只服务 YouTube：在别的站点装它只是白白 patch
  const hook = siteId === 'youtube' ? installTimedTextHook(win) : null;

  const site = createSite({
    win,
    doc: document,
    log,
    hook,
    // 每次抓取时现读偏好：用户中途切成中文，下一次 load 立刻生效
    readChoice: () => getPrefs().lang,
    autoSwitchTrack: () => getPrefs().autoSwitchTrack,
    // 油猴在页面上下文，首屏状态直接读
    readPageState: async () => readBiliPageState(win),
  });
  if (!site) return;

  const session = createSession({ win, site });
  const client = createLocalClient({
    store: session.store,
    load: session.load,
    seek: session.seek,
  });

  // 挂载点由站点决定：YouTube = 右栏卡片 + masthead 按钮，B 站 = 右下浮层
  const panel = site.mount({
    doc: document,
    css: panelCss,
    client,
    currentVideoId: () => site.videoIdOf(win.location),
  });

  // 用户手动点开 YouTube 的 Transcript 标签页时，页面会自己发 get_panel。
  // 截获后立刻自动重载，不需要再点「重试」。（B 站没有这条通路）
  if (hook) {
    hook.onCapture((capture) => {
      if (capture.kind !== 'get_panel' && capture.kind !== 'get_transcript') return;
      if (session.store.getState().status !== 'error') return;
      void session.load(true);
    });
  }

  let lastUrl = '';

  const tick = (): void => {
    if (location.href === lastUrl) return;

    // 每一步单独隔离：任何一步抛异常都不能吃掉后面的同步。
    // 尤其是 lastUrl 必须在**全部干完之后**才更新 —— 否则一次异常就会把
    // 这个 URL 标记成「已处理」，此后每次 tick 都在第一行 return，面板
    // 会永久冻结在旧视频上（这正是「标题也不变」的来源）。
    try {
      // 切页不再关面板：宿主被站点重建时自动挂回去，保持展开
      panel.ensureMounted();
    } catch (error) {
      log({ code: 'UNKNOWN', source: 'host', detail: `panel remount failed: ${String(error)}` });
    }

    try {
      session.sync();
    } catch (error) {
      log({ code: 'UNKNOWN', source: 'host', detail: `session sync failed: ${String(error)}` });
    }

    lastUrl = location.href;
  };

  tick();
  setInterval(tick, 500);
  // 定时对账：即使 tick 因为任何原因没跑，面板也会在 500ms 内跟上切页
  session.start();
})();
