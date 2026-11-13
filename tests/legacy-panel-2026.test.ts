import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/**
 * 用户确认的现象：点 Copy Transcript 后字幕框先打开、里面全是字幕行，
 * 隔几秒才弹「Could not find the transcript panel」。
 * 这些测试用 node:vm 真实执行修好的 user-script.js（verbatim-runtime.js），
 * 证明「面板认得出 → 字幕读得走 → 剪贴板写得到 → 不再 alert」。
 */

const SOURCE = readFileSync(
  new URL('../src/legacy/verbatim-runtime.js', import.meta.url),
  'utf8',
);

const SUBTITLES = [
  '0:02 Welcome everyone to Rails World',
  '0:05 Let me start with a quick story',
  '0:09 Today we are going to talk about',
  '0:14 And I want to show you something',
  '0:19 Follow along using the transcript',
  '0:24 So the first thing I want to say',
].join('\n');

const CHAPTERS = [
  '28:14 Chapter 1 What portrait painters can teach us about AI',
  '33:04 Chapter 2 Where does this leave Ruby and Rails',
  '34:23 Chapter 3 Agent evals with Evil Martians',
  '36:28 Chapter 4 Many lines of code in a month',
].join('\n');

interface Panel {
  name: string;
  attrs: Record<string, string>;
  innerText: string;
  getAttribute(name: string): string;
  getClientRects(): { width: number }[];
  querySelector(): null;
  querySelectorAll(): never[];
  tagName: string;
}

function panel(name: string, attrs: Record<string, string>, innerText: string): Panel {
  return {
    name,
    attrs,
    innerText,
    tagName: 'YTD-ENGAGEMENT-PANEL-SECTION-LIST-RENDERER',
    getAttribute: (key: string) => attrs[key] ?? '',
    getClientRects: () => [{ width: 1 }],
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

interface Sandbox {
  __yttLegacyV19?: Record<string, unknown>;
  __yttSharedPrefs?: { timestamps: boolean; view: string };
  alert: ReturnType<typeof vi.fn>;
  clipboardWrite: ReturnType<typeof vi.fn>;
  triggerClick?: ReturnType<typeof vi.fn>;
  panels: Panel[];
}

/**
 * 构造 2026 假 DOM。panels 里的 EXPANDED / HIDDEN 与真实 dump 一致：
 * 展开的那块 target-id=""、字幕面板叫 PAmodern_transcript_view 且 HIDDEN。
 */
function load2026(options: {
  expandedText: string;
  renderOnTrigger?: boolean;
}): Sandbox {
  const expanded = panel('expanded', {
    'target-id': '',
    visibility: 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED',
  }, options.expandedText);
  const hidden = panel('PAmodern_transcript_view', {
    'target-id': 'PAmodern_transcript_view',
    visibility: 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN',
  }, '');
  const comments = panel('comments', {
    'target-id': 'engagement-panel-comments-section',
    visibility: 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN',
  }, 'Comments 1.8K Top Show featured comments Newest');
  // 真实 dump 里章节面板是 HIDDEN + target-id="engagement-panel-macro-markers-description-chapters"
  const chapters = panel('chapters', {
    'target-id': 'engagement-panel-macro-markers-description-chapters',
    visibility: 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN',
  }, CHAPTERS);

  const panels = [expanded, hidden, comments, chapters];
  const alert = vi.fn();
  const clipboardWrite = vi.fn(async () => undefined);
  const triggerClick = vi.fn(() => {
    if (options.renderOnTrigger) expanded.innerText = SUBTITLES;
  });
  const trigger = {
    textContent: 'Show transcript',
    getAttribute: () => '',
    click: triggerClick,
  };

  const doc = {
    body: { innerText: '' },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: (selector: string) => {
      // 章节选择器只应命中真正的章节面板，不能把字幕面板算进来
      if (selector.includes('[target-id*="chapter"]') ||
          selector.includes('[target-id*="macro-markers"]')) {
        return [chapters];
      }
      // SEL.panels 同时含 [visibility*="EXPANDED"] 与 [target-id*="transcript"]
      if (selector.includes('[visibility*="EXPANDED"]') ||
          selector.includes('[target-id*="transcript"]')) {
        return [expanded, chapters, hidden];
      }
      if (selector.includes('button')) return [trigger];
      return [];
    },
    createElement: () => ({ style: {} }),
  };

  // sleep(150/400) 必须真的 resolve；2000/1500 的 addCopyButton、reset 一律不跑
  const realSetTimeout = globalThis.setTimeout;
  const sandbox: Sandbox = {
    alert,
    clipboardWrite,
    triggerClick,
    panels,
  };
  const scope = sandbox as unknown as Record<string, unknown>;
  scope.document = doc;
  scope.navigator = { clipboard: { writeText: clipboardWrite } };
  scope.location = { href: 'https://www.youtube.com/watch?v=vDjW_dRyKXY' };
  scope.console = console;
  scope.alert = alert;
  scope.setTimeout = (fn: () => void, ms: number) =>
    ms === 150 || ms === 400 ? realSetTimeout(fn, 0) : 0;
  scope.clearTimeout = () => undefined;
  scope.setInterval = () => 0;
  scope.clearInterval = () => undefined;
  scope.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  scope.window = scope;
  scope.globalThis = scope;

  runInNewContext(SOURCE, scope);
  return sandbox;
}

function api(sandbox: Sandbox): Record<string, (...args: unknown[]) => unknown> {
  return sandbox.__yttLegacyV19 as unknown as Record<string, (...args: unknown[]) => unknown>;
}

describe('2026 面板识别：Copy Transcript 不再空等后弹 alert', () => {
  it('pickPanel 选中含字幕行的 EXPANDED 面板，不选隐藏面板与章节面板', () => {
    const sandbox = load2026({ expandedText: SUBTITLES });
    const chosen = api(sandbox).pickPanel() as unknown as Panel;
    expect(chosen).toBeTruthy();
    expect(chosen.name).toBe('expanded');
    const sel = (sandbox.__yttLegacyV19 as unknown as { SEL: { panels: string } }).SEL;
    expect(sel.panels).toContain('[visibility*="EXPANDED"]');
    expect(sel.panels).toContain('[target-id*="transcript"]');
  });

  it('字幕行一出现 waitForSegments 立即就绪；停在 Chapters 时 pickPanel 返回 null', async () => {
    const ready = load2026({ expandedText: SUBTITLES });
    const chosen = api(ready).pickPanel() as unknown as Panel;
    expect(await api(ready).waitForSegments(chosen, 3000)).toBe(true);

    const chaptersOnly = load2026({ expandedText: CHAPTERS });
    expect(api(chaptersOnly).pickPanel()).toBeNull();
  });

  it('停在 Chapters 时仍照旧点 Show transcript，字幕渲染后立刻返回面板', async () => {
    const sandbox = load2026({ expandedText: CHAPTERS, renderOnTrigger: true });
    const chosen = (await api(sandbox).openTranscriptPanel()) as unknown as Panel;
    expect(sandbox.triggerClick).toHaveBeenCalledTimes(1);
    expect(chosen).toBeTruthy();
    expect(chosen.name).toBe('expanded');
    expect(sandbox.alert).not.toHaveBeenCalled();
  });

  it('extractFallback 从 2026 面板 innerText 切出完整字幕', () => {
    const sandbox = load2026({ expandedText: SUBTITLES });
    const chosen = api(sandbox).pickPanel() as unknown as Panel;
    const result = api(sandbox).extractFallback(chosen) as { text: string };
    expect(result.text.split('\n')).toHaveLength(6);
    expect(result.text.split('\n')[0]).toBe('0:02 Welcome everyone to Rails World');
  });

  it('buildButton().onclick 把字幕写进剪贴板并显示 Copied，完全不弹 alert', async () => {
    const sandbox = load2026({ expandedText: SUBTITLES });
    const btn = api(sandbox).buildButton() as unknown as {
      id: string;
      textContent: string;
      onclick: () => Promise<void>;
    };

    expect(btn.id).toBe('copy-transcript-btn');
    expect(btn.textContent).toBe('Copy Transcript');
    await btn.onclick();

    expect(sandbox.alert).not.toHaveBeenCalled();
    expect(sandbox.clipboardWrite).toHaveBeenCalledTimes(1);
    const copied = sandbox.clipboardWrite.mock.calls[0][0] as string;
    expect(copied.split('\n')).toHaveLength(6);
    // 默认与新版面板共用 timestamps=true，所以是带时间的 Copied!
    expect(btn.textContent).toBe('Copied!');
    expect(copied.split('\n')[0]).toMatch(/^0:02 /u);
  });

  it('Shift 点击把复制切换成不带时间，并写回共享偏好', async () => {
    const sandbox = load2026({ expandedText: SUBTITLES });
    const btn = api(sandbox).buildButton() as unknown as {
      textContent: string;
      onclick: (event: { shiftKey: boolean; altKey: boolean }) => Promise<void>;
    };

    await btn.onclick({ shiftKey: true, altKey: false });
    const copied = sandbox.clipboardWrite.mock.calls[0][0] as string;
    expect(copied.split('\n')[0]).toBe('Welcome everyone to Rails World');
    expect(btn.textContent).toBe('Copied (no timestamps)!');
    expect(sandbox.__yttSharedPrefs?.timestamps).toBe(false);
  });

  it('Alt 点击复制章节，且不需要先打开字幕面板', async () => {
    const sandbox = load2026({ expandedText: SUBTITLES });
    const btn = api(sandbox).buildButton() as unknown as {
      onclick: (event: { shiftKey: boolean; altKey: boolean }) => Promise<void>;
    };
    await btn.onclick({ shiftKey: false, altKey: true });
    const copied = sandbox.clipboardWrite.mock.calls[0][0] as string;
    expect(copied).toContain('28:14 Chapter 1');
    expect(sandbox.alert).not.toHaveBeenCalled();
  });
});
