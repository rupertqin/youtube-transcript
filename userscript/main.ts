import '../src/legacy/verbatim-runtime.js';
import panelCss from '../src/ui/styles.css?inline';
import { ensureEntryButton, removeEntryButton } from '../src/core/dom/button';
import { extractTranscriptLegacy } from '../src/core/dom/legacy';
import { installShadowCapture } from '../src/core/dom/shadow';
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
  installShadowCapture(window);
  const LANGS = defaultLangs();
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
          cachedIntercept: () =>
            runInterceptSource({ videoId, langs: LANGS, signal, log }, hook, 0),
          intercept: (timeoutMs) =>
            runInterceptSource({ videoId, langs: LANGS, signal, log }, hook, timeoutMs),
          dom: async () => {
            // 1.x 原版流程逐行移植：面板由它自己打开/收回，不再由兜底链并行触发
            const result = await extractTranscriptLegacy(document);
            if (result.lines.length === 0) return null;
            return { lines: result.lines, source: 'dom', showTimestamps: result.showTimestamps };
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

  // 用户手动点开 YouTube 的 Transcript 标签页时，页面会自己发 get_transcript。
  // 截获后立刻自动重载，不需要再点「重试」。
  hook.onCapture((capture) => {
    if (capture.kind !== 'get_transcript') return;
    if (session.store.getState().status !== 'error') return;
    void session.load(true);
  });

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
