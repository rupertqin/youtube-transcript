import { describe, expect, it, vi } from 'vitest';
import { harvestTranscript, HarvestError } from '../src/core/harvest/chain';
import type { FailureRecord, SourceName, SourceOutcome } from '../src/core/types';

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

describe('抓取兜底链', () => {
  it('② 播放器成功就短路，不再打开原生面板', async () => {
    const openPanel = vi.fn();
    const intercept = vi.fn();
    const dom = vi.fn();

    const result = await harvestTranscript(
      makeDeps({ remote: async () => outcome('player'), openPanel, intercept, dom }),
    );

    expect(result.source).toBe('player');
    expect(result.lines).toHaveLength(3);
    expect(openPanel).not.toHaveBeenCalled();
    expect(intercept).not.toHaveBeenCalled();
    expect(dom).not.toHaveBeenCalled();
  });

  it('远程失败后走 ① 拦截，并保留失败记录', async () => {
    const failure: FailureRecord = { source: 'player', code: 'EMPTY_200', ms: 12 };
    const openPanel = vi.fn(async () => 'panel');

    const result = await harvestTranscript(
      makeDeps({
        remote: async () => ({ ...outcome('player', 0), failures: [failure] }),
        openPanel,
        intercept: async () => outcome('intercept'),
      }),
    );

    expect(result.source).toBe('intercept');
    expect(result.failures).toEqual([failure]);
    expect(openPanel).toHaveBeenCalledTimes(1);
  });

  it('① 也失败时用 ③ DOM，且共用同一次打开面板动作', async () => {
    const openPanel = vi.fn(async () => 'panel-node');
    const dom = vi.fn(async (panel: unknown) => {
      expect(panel).toBe('panel-node');
      return outcome('dom');
    });

    const result = await harvestTranscript(
      makeDeps({
        remote: async () => null,
        openPanel,
        intercept: async () => null,
        dom,
      }),
    );

    expect(result.source).toBe('dom');
    expect(openPanel).toHaveBeenCalledTimes(1);
    expect(dom).toHaveBeenCalledTimes(1);
  });

  it('远程抛错不会中断链路', async () => {
    const result = await harvestTranscript(
      makeDeps({
        remote: async () => {
          throw Object.assign(new Error('boom'), { code: 'NETWORK_ERROR' });
        },
        intercept: async () => outcome('intercept'),
      }),
    );

    expect(result.source).toBe('intercept');
    expect(result.failures?.[0]?.code).toBe('NETWORK_ERROR');
  });

  it('全部失败时抛出最后一次失败的分类', async () => {
    await expect(
      harvestTranscript(
        makeDeps({
          remote: async () => null,
          intercept: async () => null,
          dom: async () => null,
        }),
      ),
    ).rejects.toBeInstanceOf(HarvestError);
  });

  it('错误码取最后一层，失败链保留每一层', async () => {
    try {
      await harvestTranscript(
        makeDeps({
          remote: async () => ({
            ...outcome('player', 0),
            failures: [{ source: 'player', code: 'POT_ENFORCED', ms: 30 }],
          }),
          intercept: async () => null,
          dom: async () => null,
        }),
      );
      expect.unreachable('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HarvestError);
      const failure = error as HarvestError;
      // 最后一层是 DOM，它没拿到行 → SELECTOR_MISS，而不是上游的 POT_ENFORCED
      expect(failure.code).toBe('SELECTOR_MISS');
      expect(failure.failures.map((item) => item.code)).toEqual([
        'POT_ENFORCED',
        'EMPTY_200',
        'SELECTOR_MISS',
      ]);
    }
  });

  it('打开过原生面板就一定收回（成功路径也收）', async () => {
    const closePanel = vi.fn();
    await harvestTranscript(
      makeDeps({
        remote: async () => ({ ...outcome('player', 0), failures: [] }),
        openPanel: async () => 'panel-node',
        closePanel,
        intercept: async () => outcome('intercept'),
      }),
    );
    expect(closePanel).toHaveBeenCalledWith('panel-node');
  });

  it('DOM 也失败后，再白拿一次已捕获的拦截结果', async () => {
    const intercept = vi
      .fn()
      .mockResolvedValueOnce(null) // 第一次等待超时
      .mockResolvedValueOnce(outcome('intercept')); // DOM 等待期间面板请求刚到

    const result = await harvestTranscript(
      makeDeps({
        remote: async () => null,
        openPanel: async () => 'panel-node',
        closePanel: () => undefined,
        intercept,
        dom: async () => null,
      }),
    );

    expect(result.source).toBe('intercept');
    expect(intercept).toHaveBeenLastCalledWith(0);
  });

  it('失败路径同样收回原生面板', async () => {
    const closePanel = vi.fn();
    await expect(
      harvestTranscript(
        makeDeps({
          remote: async () => null,
          openPanel: async () => 'panel-node',
          closePanel,
          intercept: async () => null,
          dom: async () => null,
        }),
      ),
    ).rejects.toBeInstanceOf(HarvestError);
    expect(closePanel).toHaveBeenCalledWith('panel-node');
  });
});
