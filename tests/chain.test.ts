import { describe, expect, it, vi } from 'vitest';
import { harvestTranscript, HarvestError } from '../src/core/harvest/chain';
import type { SourceName, SourceOutcome } from '../src/core/types';

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    start: index * 1000,
    dur: 900,
    text: `line ${index}`,
  }));
}

function outcome(source: SourceName, count = 3): SourceOutcome {
  return { lines: lines(count), source, showTimestamps: true };
}

const noopLog = vi.fn();

function makeDeps(overrides: Partial<Parameters<typeof harvestTranscript>[0]> = {}) {
  return {
    signal: new AbortController().signal,
    log: noopLog,
    ...overrides,
  };
}

describe('抓取兜底链（完整结构化源优先，DOM 只做同步预览）', () => {
  it('结构化源一次拿到全部分段就短路，结果标记为完整', async () => {
    const intercept = vi.fn();
    const remote = vi.fn();
    const result = await harvestTranscript(
      makeDeps({
        structured: async () => outcome('innertube'),
        domPreview: () => outcome('dom'),
        intercept,
        remote,
      }),
    );

    expect(result.source).toBe('innertube');
    expect(result.complete).toBe(true);
    expect(result.lines).toHaveLength(3);
    expect(intercept).not.toHaveBeenCalled();
    expect(remote).not.toHaveBeenCalled();
  });

  it('已截获的完整响应 0ms 命中，连结构化请求都不发', async () => {
    const structured = vi.fn();
    const result = await harvestTranscript(
      makeDeps({
        cachedIntercept: async () => outcome('intercept'),
        structured,
        domPreview: () => null,
        intercept: async () => null,
        remote: async () => null,
      }),
    );

    expect(result.source).toBe('intercept');
    expect(result.complete).toBe(true);
    expect(structured).not.toHaveBeenCalled();
  });

  it('DOM 预览只回传、绝不短路：完整结果仍会把它替换掉', async () => {
    const onPreview = vi.fn();
    const preview = outcome('dom', 2);
    const result = await harvestTranscript(
      makeDeps({
        domPreview: () => ({ ...preview, complete: false }),
        onPreview,
        structured: async () => outcome('innertube', 120),
        intercept: async () => null,
        remote: async () => null,
      }),
    );

    expect(onPreview).toHaveBeenCalledWith(preview.lines);
    expect(result.source).toBe('innertube');
    expect(result.lines).toHaveLength(120);
  });

  it('结构化源失败后走拦截，并记下失败分类', async () => {
    const result = await harvestTranscript(
      makeDeps({
        structured: async () => null,
        intercept: async () => outcome('intercept'),
        remote: async () => outcome('player'),
      }),
    );

    expect(result.source).toBe('intercept');
    expect(result.failures.map((item) => item.code)).toEqual(['NO_CAPTION_TRACK']);
  });

  it('结构化 + 拦截都失败才去问远程', async () => {
    const result = await harvestTranscript(
      makeDeps({
        structured: async () => null,
        intercept: async () => null,
        remote: async () => outcome('player'),
      }),
    );

    expect(result.source).toBe('player');
    expect(result.failures.map((item) => item.code)).toEqual(['NO_CAPTION_TRACK', 'EMPTY_200']);
  });

  it('全部完整源失败：即使有 DOM 预览也报错，不把残缺内容当成功', async () => {
    const onPreview = vi.fn();
    await expect(
      harvestTranscript(
        makeDeps({
          domPreview: () => outcome('dom'),
          onPreview,
          structured: async () => null,
          intercept: async () => null,
          remote: async () => null,
        }),
      ),
    ).rejects.toBeInstanceOf(HarvestError);
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it('远程抛错不会中断链路，错误码跟随该层', async () => {
    await expect(
      harvestTranscript(
        makeDeps({
          structured: async () => null,
          intercept: async () => null,
          remote: async () => {
            throw Object.assign(new Error('boom'), { code: 'NETWORK_ERROR' });
          },
        }),
      ),
    ).rejects.toBeInstanceOf(HarvestError);
  });

  it('成功路径也会 await 收起残留的原生面板', async () => {
    let closed = false;
    await harvestTranscript(
      makeDeps({
        structured: async () => outcome('innertube'),
        closePanel: async () => {
          await Promise.resolve();
          closed = true;
        },
      }),
    );
    expect(closed).toBe(true);
  });

  it('失败路径同样 await 收起原生面板', async () => {
    const closePanel = vi.fn(async () => undefined);
    await expect(
      harvestTranscript(
        makeDeps({
          structured: async () => null,
          intercept: async () => null,
          remote: async () => null,
          closePanel,
        }),
      ),
    ).rejects.toBeInstanceOf(HarvestError);
    expect(closePanel).toHaveBeenCalledTimes(1);
  });

  it('收面板抛错不影响抓取结果', async () => {
    const result = await harvestTranscript(
      makeDeps({
        structured: async () => outcome('innertube'),
        closePanel: async () => {
          throw new Error('no close button');
        },
      }),
    );
    expect(result.source).toBe('innertube');
  });

  it('要翻译时远程先跑，不被原文结构化源顶替', async () => {
    const calls: string[] = [];
    const result = await harvestTranscript(
      makeDeps({
        preferRemote: true,
        remote: async () => {
          calls.push('remote');
          return outcome('player');
        },
        structured: async () => {
          calls.push('structured');
          return outcome('innertube');
        },
      }),
    );
    expect(calls).toEqual(['remote']);
    expect(result.source).toBe('player');
  });

  it('中断信号会立即抛出，不会继续往下试', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      harvestTranscript({
        signal: controller.signal,
        log: noopLog,
        structured: async () => outcome('innertube'),
        remote: async () => outcome('player'),
      }),
    ).rejects.toBeInstanceOf(HarvestError);
  });
});

/**
 * 最糟的失败形态：面板里明明渲染着字幕，我们却报「这个视频没有字幕轨道」。
 * 真实案例（JW5s9Md4U2U）：结构化源 400 Precondition check failed、
 * timedtext 空 body、InnerTube 探不到轨道，而 DOM 里躺着 376 行。
 */
describe('所有完整源都失败时的 DOM 兜底', () => {
  const everythingFails = () => ({
    structured: async () => {
      throw new Error('HTTP 400 Precondition check failed');
    },
    intercept: async () => null,
    remote: async () => null,
  });

  it('页面已渲染的字幕会作为兜底返回，且标记为不完整', async () => {
    const result = await harvestTranscript(
      makeDeps({
        ...everythingFails(),
        domPreview: () => outcome('dom', 2),
        domFallback: () => outcome('dom', 376),
      }),
    );

    expect(result.source).toBe('dom');
    expect(result.lines).toHaveLength(376);
    // 关键：不完整 → session 不会写缓存，下次还会重新抓完整版
    expect(result.complete).toBe(false);
  });

  it('兜底也不为空时才用；它没内容就照旧报错', async () => {
    await expect(
      harvestTranscript(
        makeDeps({
          ...everythingFails(),
          domPreview: () => null,
          domFallback: () => null,
        }),
      ),
    ).rejects.toBeInstanceOf(HarvestError);
  });

  it('完整源成功时不会走兜底', async () => {
    const domFallback = vi.fn(() => outcome('dom', 376));
    const result = await harvestTranscript(
      makeDeps({
        structured: async () => outcome('innertube'),
        domPreview: () => outcome('dom', 2),
        domFallback,
      }),
    );

    expect(result.source).toBe('innertube');
    expect(result.complete).toBe(true);
    expect(domFallback).not.toHaveBeenCalled();
  });
});

describe('全部失败时的错误码', () => {
  it('主路径的真实错误优先于末层探测的 NO_CAPTION_TRACK', async () => {
    await expect(
      harvestTranscript(
        makeDeps({
          structured: async () => {
            throw new Error('HTTP 400 Precondition check failed');
          },
          remote: async () => ({
            lines: [],
            source: 'innertube',
            showTimestamps: true,
            failures: [{ source: 'innertube', code: 'NO_CAPTION_TRACK', ms: 1, detail: 'no track' }],
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});
