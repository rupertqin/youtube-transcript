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

describe('抓取兜底链（原版顺序：DOM → 拦截 → 远程）', () => {
  it('DOM 成功就短路，不再走拦截与远程', async () => {
    const openPanel = vi.fn(async () => 'panel-node');
    const intercept = vi.fn();
    const remote = vi.fn();

    const result = await harvestTranscript(
      makeDeps({ openPanel, dom: async () => outcome('dom'), intercept, remote }),
    );

    expect(result.source).toBe('dom');
    expect(result.lines).toHaveLength(3);
    expect(openPanel).toHaveBeenCalledTimes(1);
    expect(intercept).not.toHaveBeenCalled();
    expect(remote).not.toHaveBeenCalled();
  });

  it('dom 拿到的就是 openPanel 返回的那个面板节点', async () => {
    const dom = vi.fn(async (panel: unknown) => {
      expect(panel).toBe('panel-node');
      return outcome('dom');
    });

    await harvestTranscript(makeDeps({ openPanel: async () => 'panel-node', dom }));
    expect(dom).toHaveBeenCalledTimes(1);
  });

  it('已有缓存捕获时 0ms 命中，连面板都不用开', async () => {
    const dom = vi.fn(async () => null);
    const result = await harvestTranscript(
      makeDeps({
        openPanel: async () => 'panel-node',
        cachedIntercept: async () => outcome('intercept'),
        dom,
        intercept: async () => null,
        remote: async () => null,
      }),
    );

    expect(result.source).toBe('intercept');
    expect(dom).not.toHaveBeenCalled();
  });

  it('DOM 失败后走 ① 拦截，并保留失败记录', async () => {
    const result = await harvestTranscript(
      makeDeps({
        openPanel: async () => 'panel-node',
        dom: async () => null,
        intercept: async () => outcome('intercept'),
        remote: async () => outcome('player'),
      }),
    );

    expect(result.source).toBe('intercept');
    expect(result.failures.map((item) => item.code)).toEqual(['SELECTOR_MISS']);
  });

  it('DOM + 拦截都失败才去问远程', async () => {
    const result = await harvestTranscript(
      makeDeps({
        openPanel: async () => 'panel-node',
        dom: async () => null,
        intercept: async () => null,
        remote: async () => outcome('player'),
      }),
    );

    expect(result.source).toBe('player');
    expect(result.failures.map((item) => item.code)).toEqual(['SELECTOR_MISS', 'EMPTY_200']);
  });

  it('全部失败：DOM 结构问题优先上报，避免误报「没字幕」', async () => {
    await expect(
      harvestTranscript(
        makeDeps({
          openPanel: async () => 'panel-node',
          dom: async () => null,
          intercept: async () => null,
          remote: async () => ({
            ...outcome('player', 0),
            failures: [{ source: 'player', code: 'POT_ENFORCED', ms: 30 }],
          }),
        }),
      ),
    ).rejects.toMatchObject({
      // 远程说的是 POT_ENFORCED，但 DOM 说「读不到行」——后者才是能动手修的那个
      code: 'SELECTOR_MISS',
      failures: [{ code: 'SELECTOR_MISS' }, { code: 'EMPTY_200' }, { code: 'POT_ENFORCED' }],
    });
  });

  it('远程抛错不会中断链路，错误码跟随该层', async () => {
    await expect(
      harvestTranscript(
        makeDeps({
          openPanel: async () => 'panel-node',
          dom: async () => null,
          intercept: async () => null,
          remote: async () => {
            throw Object.assign(new Error('boom'), { code: 'NETWORK_ERROR' });
          },
        }),
      ),
    ).rejects.toBeInstanceOf(HarvestError);
  });

  it('打开过原生面板就一定收回（成功路径也收）', async () => {
    const closePanel = vi.fn();
    await harvestTranscript(
      makeDeps({ openPanel: async () => 'panel-node', closePanel, dom: async () => outcome('dom') }),
    );
    expect(closePanel).toHaveBeenCalledWith('panel-node');
  });

  it('失败路径同样收回原生面板', async () => {
    const closePanel = vi.fn();
    await expect(
      harvestTranscript(
        makeDeps({
          openPanel: async () => 'panel-node',
          closePanel,
          dom: async () => null,
          intercept: async () => null,
          remote: async () => null,
        }),
      ),
    ).rejects.toBeInstanceOf(HarvestError);
    expect(closePanel).toHaveBeenCalledWith('panel-node');
  });

  it('中断信号会立即抛出，不会继续往下试', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      harvestTranscript({
        signal: controller.signal,
        log: noopLog,
        openPanel: async () => 'panel-node',
        dom: async () => outcome('dom'),
        remote: async () => outcome('player'),
      }),
    ).rejects.toBeInstanceOf(HarvestError);
  });
});
