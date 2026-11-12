import panelCss from '../src/ui/styles.css?inline';
import { ensureEntryButton, removeEntryButton } from '../src/core/dom/button';
import { pickPanel } from '../src/core/dom/panel';
import { createPanelSession } from '../src/core/dom/panel-session';
import { scrapePanel } from '../src/core/dom/scrape';
import { harvestTranscript } from '../src/core/harvest/chain';
import { installTimedTextHook } from '../src/core/harvest/intercept';
import { readTitle, readVideoId } from '../src/core/harvest/player';
import { runInterceptSource, runRemoteSources } from '../src/core/harvest/sources';
import { defaultLangs } from '../src/core/langs';
import { log } from '../src/core/log';
import { createLocalClient } from '../src/platform/local-client';
import { createSession } from '../src/platform/session';
import { createOverlay } from '../src/ui/overlay';

/**
 * 油猴入口：`@grant none` 让脚本本身就跑在页面上下文，
 * 所以 ①②③④ 全在同一个进程里，不需要 MAIN/ISOLATED 消息桥。
 * 这也是「共享核心」能成立的关键 —— core 的每一层只认传入的 window。
 */
(() => {
  'use strict';

  const win = window;
  const LANGS = defaultLangs();
  const panelSession = createPanelSession(document);
  const hook = installTimedTextHook(win);

  const session = createSession({
    win,
    hooks: {
      title: () => readTitle(win),
      harvest: (videoId, signal, onStage) =>
        harvestTranscript({
          signal,
          log,
          onStage,
          remote: () => runRemoteSources({ win, ctx: { videoId, langs: LANGS, signal, log } }),
          intercept: (timeoutMs) =>
            runInterceptSource({ videoId, langs: LANGS, signal, log }, hook, timeoutMs),
          openPanel: panelSession.openPanel,
          closePanel: panelSession.closePanel,
          dom: async (panel) => {
            const target = (panel as Element | null) ?? pickPanel(document);
            if (!target) return null;
            const scraped = await scrapePanel(target);
            if (scraped.lines.length === 0) return null;
            return { lines: scraped.lines, source: 'dom', showTimestamps: scraped.showTimestamps };
          },
        }),
    },
  });

  const client = createLocalClient({
    store: session.store,
    load: session.load,
    seek: session.seek,
  });

  const overlay = createOverlay({ doc: document, css: panelCss, client });

  const refreshButton = async (): Promise<void> => {
    if (!readVideoId(win)) {
      removeEntryButton(document);
      return;
    }
    await ensureEntryButton({
      doc: document,
      label: 'Transcript',
      title: '打开字幕面板',
      onClick: () => overlay.toggle(),
    });
  };

  let lastUrl = '';

  const tick = (): void => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    overlay.hide();
    session.sync();
    void refreshButton();
  };

  tick();
  setInterval(tick, 500);
})();
