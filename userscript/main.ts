import panelCss from '../src/ui/styles.css?inline';
import { ensureEntryButton, flashEntryButton, removeEntryButton } from '../src/core/dom/button';
import { readDomPreview } from '../src/core/dom/native-panel';
import { closeTranscriptPanelVerified } from '../src/core/dom/panel';
import { installShadowCapture } from '../src/core/dom/shadow';
import { harvestTranscript } from '../src/core/harvest/chain';
import { fetchGetTranscript } from '../src/core/harvest/get-transcript';
import { installTimedTextHook } from '../src/core/harvest/intercept';
import { hasNativeTrackFor, readAvailableLangs, readTitleFor, readVideoId } from '../src/core/harvest/player';
import { runInterceptSource, runRemoteSources } from '../src/core/harvest/sources';
import { pickUsableChoice, resolveLangPlan } from '../src/core/langs';
import { log } from '../src/core/log';
import { createLocalClient } from '../src/platform/local-client';
import { createSession } from '../src/platform/session';
import { getPrefs } from '../src/ui/prefs';
import { createSidebarPanel } from '../src/ui/sidebar';

/**
 * 油猴入口：`@grant none` 让脚本本身就跑在页面上下文，
 * 所以 ①②③④ 全在同一个进程里，不需要 MAIN/ISOLATED 消息桥。
 * 这也是「共享核心」能成立的关键 —— core 的每一层只认传入的 window。
 */
(() => {
  'use strict';

  const win = window;
  installShadowCapture(window);
  const hook = installTimedTextHook(win);

  // 每次抓取时现读偏好：用户中途切成中文，下一次 load 立刻生效。
  // 视频给不了所选语言时按「同音频」处理 —— 和按钮的禁用状态保持一致。
  const langPlan = () => {
    const available = readAvailableLangs(win, readVideoId(win) ?? undefined);
    return resolveLangPlan(pickUsableChoice(getPrefs().lang, available));
  };

  const session = createSession({
    win,
    hooks: {
      // 标题按 videoId 取：对不上 playerResponse 就退回 document.title，
      // 避免出现「新字幕配旧标题」
      title: (videoId) => readTitleFor(win, videoId),
      langPlan,
      harvest: (videoId, signal, onStage, options) => {
        const plan = langPlan();
        // 没有目标语言的原生轨道时，拦截层/结构化源只能给原文 —— 必须让远程先上
        const needsTranslation = Boolean(plan.tlang) && !hasNativeTrackFor(win, plan.tlang!);
        const ctx = { videoId, langs: plan.langs, tlang: plan.tlang, signal, log };

        return harvestTranscript({
          signal,
          log,
          onStage,
          preferRemote: needsTranslation,
          remote: () => runRemoteSources({ win, ctx }),
          cachedIntercept: () => runInterceptSource(ctx, hook, 0),
          // 主路径：一次 get_transcript 拿回全部分段，不碰虚拟列表
          structured: async () => {
            if (plan.tlang) return null; // 要翻译时不能拿原文顶替
            const outcome = await fetchGetTranscript({
              win,
              fetchFn: win.fetch.bind(win),
              videoId,
              langs: plan.langs,
              signal,
              timeoutMs: 6_000,
              maxAttempts: 10,
            });
            if (!outcome || outcome.lines.length === 0) return null;
            return {
              lines: outcome.lines,
              source: 'innertube',
              track: { baseUrl: `get_transcript:${outcome.params}`, languageCode: outcome.lang },
              showTimestamps: true,
              complete: true,
            };
          },
          // 只是让屏幕上先有字：一次同步扫描，不点击、不等待、不滚动
          domPreview: () => {
            const result = readDomPreview(document, {
              videoId,
              skipSnapshot: options?.staleRisk,
              avoidSignature: options?.avoid ?? null,
            });
            if (result.lines.length === 0) return null;
            return {
              lines: result.lines,
              source: 'dom',
              showTimestamps: result.showTimestamps,
              complete: false,
            };
          },
          onPreview: options?.onPreview,
          intercept: (timeoutMs) => runInterceptSource(ctx, hook, timeoutMs),
          // 页面上残留的原生面板，抓取结束一律验证式收起
          closePanel: () => closeTranscriptPanelVerified(document),
        });
      },
    },
  });

  const client = createLocalClient({
    store: session.store,
    load: session.load,
    seek: session.seek,
  });

  // 面板不再是浮层：嵌进观看页右栏，跟着页面滚动
  const sidebar = createSidebarPanel({ doc: document, css: panelCss, client });

  const refreshButton = async (): Promise<void> => {
    if (!readVideoId(win)) {
      removeEntryButton(document);
      return;
    }
    await ensureEntryButton({
      doc: document,
      label: 'Transcript',
      title: '在右栏打开字幕',
      onClick: () => {
        if (sidebar.isOpen()) {
          sidebar.hide();
          return;
        }
        // 没有右栏（Shorts 等）时不打开任何浮层，只在按钮上提示一下
        if (!sidebar.show()) flashEntryButton(document, '当前页面没有右栏');
      },
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

    // 每一步单独隔离：任何一步抛异常都不能吃掉后面的同步。
    // 尤其是 lastUrl 必须在**全部干完之后**才更新 —— 否则一次异常就会把
    // 这个 URL 标记成「已处理」，此后每次 tick 都在第一行 return，面板
    // 会永久冻结在旧视频上（这正是「标题也不变」的来源）。
    try {
      // 切页不再关面板：右栏被 YouTube 重建时自动挂回去，保持展开
      sidebar.ensureMounted();
    } catch (error) {
      log({ code: 'UNKNOWN', source: 'host', detail: `sidebar remount failed: ${String(error)}` });
    }

    try {
      session.sync();
    } catch (error) {
      log({ code: 'UNKNOWN', source: 'host', detail: `session sync failed: ${String(error)}` });
    }

    void refreshButton();
    lastUrl = location.href;
  };

  tick();
  setInterval(tick, 500);
  // 定时对账：即使 tick 因为任何原因没跑，面板也会在 500ms 内跟上切页
  session.start();
})();
