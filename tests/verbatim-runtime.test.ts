import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/**
 * 「往多了抄」的验收标准：整份原版脚本必须真的能执行到底，
 * 并把全部内部函数挂到 __yttLegacyV19 上。
 * 用假的 timer 只挂不跑，避免 addCopyButton / SPA setInterval 需要真实 DOM。
 */
function loadRuntime(): Record<string, unknown> {
  const source = readFileSync(new URL('../src/legacy/verbatim-runtime.js', import.meta.url), 'utf8');
  const doc = {
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add: () => undefined } }),
  };
  const sandbox: Record<string, unknown> = {
    document: doc,
    navigator: { clipboard: { writeText: async () => undefined } },
    location: { href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    console,
    alert: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  runInNewContext(source, sandbox);
  return sandbox;
}

const ORIGINAL_API = [
  'SEL', 'sleep', 'normalize', 'waitForElement', 'isVisible', 'countSegments', 'pickPanel',
  'waitForSegments', 'openTranscriptPanel', 'segmentSelectorFor', 'collectFromList',
  'collapseDuplicates', 'extractTranscript', 'extractFallback', 'normalizeLines',
  'copyToClipboard', 'buildButton', 'addCopyButton',
];

/** 新增的共享层：两个入口调用同一份实现，不是第二套逻辑 */
const SHARED_API = [
  'formatStamp', 'stripA11yDuration', 'textToRows', 'parseChapters',
  'readChapterRows', 'formatCopyText', 'sharedPrefs', 'setSharedPrefs',
];

const EXPECTED = [...ORIGINAL_API, ...SHARED_API];

describe('整份原版 v1.9 运行时', () => {
  it('执行到底，原版 18 项 + 共享层 8 项全部可用', () => {
    const sandbox = loadRuntime();
    const api = sandbox.__yttLegacyV19 as Record<string, unknown>;
    expect(api).toBeTruthy();
    for (const name of EXPECTED) expect(typeof api[name]).not.toBe('undefined');
    for (const name of EXPECTED.slice(3)) expect(typeof api[name]).toBe('function');
  });

  it('导出名单恰好是原版 18 项 + 共享层，2026 内部辅助函数没有泄漏', () => {
    const api = loadRuntime().__yttLegacyV19 as Record<string, unknown>;
    expect(Object.keys(api)).toEqual(EXPECTED);
    expect(api.subtitleRows).toBeUndefined();
    expect(api.timecodeToMs).toBeUndefined();
    expect(api.DURATION_PHRASE).toBeUndefined();
  });

  it('原版 extractFallback 能把带时间码的面板文本切成字幕行', () => {
    const api = loadRuntime().__yttLegacyV19 as Record<string, (...args: unknown[]) => unknown>;
    const panel = {
      querySelector: () => null,
      innerText: 'Transcript\n13:48 first line\n13:59 second line\n14:09 third line',
    };
    const result = api.extractFallback(panel) as { text: string };
    expect(result.text).toBe('13:48 first line\n13:59 second line\n14:09 third line');
  });
});
