import { describe, expect, it } from 'vitest';
import { isStalePanelState, keepsRowsWhileSwitching } from '../src/ui/panel';

/**
 * 面板新鲜度闸门。
 *
 * 这是最后一道保险：只要「面板状态的 videoId」和「地址栏的 videoId」对不上，
 * 面板就必须整体退场（标题 + 行 + 复制按钮），绝不允许把上一个视频的内容
 * 当成当前的给人看。它不解决「为什么没同步」，但它保证看到的永远不会是错的。
 */
describe('isStalePanelState', () => {
  it('两个 id 一致时不陈旧', () => {
    expect(isStalePanelState('AAAAAAAAAAA', 'AAAAAAAAAAA')).toBe(false);
  });

  it('两个 id 不一致时判定陈旧（这就是「整个面板停在旧视频」的情况）', () => {
    expect(isStalePanelState('AAAAAAAAAAA', 'BBBBBBBBBBB')).toBe(true);
  });

  it('地址栏读不到 id 时不做判断，避免误杀', () => {
    // 例如 document_start 阶段、或非观看页
    expect(isStalePanelState('AAAAAAAAAAA', null)).toBe(false);
    expect(isStalePanelState('AAAAAAAAAAA', undefined)).toBe(false);
  });

  it('面板还没绑定视频时不做判断，避免首屏闪一下「切换中」', () => {
    expect(isStalePanelState('', 'BBBBBBBBBBB')).toBe(false);
    expect(isStalePanelState(null, 'BBBBBBBBBBB')).toBe(false);
  });

  it('两边都为空时不算陈旧', () => {
    expect(isStalePanelState('', null)).toBe(false);
  });
});

/**
 * 切页时别再闪：列表里已有行 + 正在取新视频时，旧行留在原地（半透明），
 * 等新数据到了原地替换。以前是清空成骨架卡再重建，视觉上就是「闪一下」。
 */
describe('keepsRowsWhileSwitching', () => {
  const base = { stale: false, status: 'loading' as const, listCount: 20, stateVideoId: 'B', shownVideoId: 'A' };

  it('换了视频 + 正在取 + 列表里有行 → 保留旧行', () => {
    expect(keepsRowsWhileSwitching(base)).toBe(true);
    expect(keepsRowsWhileSwitching({ ...base, stateVideoId: 'A', stale: true })).toBe(true);
  });

  it('同一个视频的普通重画不算切换（不显示切换提示）', () => {
    expect(keepsRowsWhileSwitching({ ...base, stateVideoId: 'A' })).toBe(false);
  });

  it('列表本来就空 → 走骨架，别留空壳', () => {
    expect(keepsRowsWhileSwitching({ ...base, listCount: 0 })).toBe(false);
  });

  it('失败时必须清空旧行、显示错误卡片', () => {
    expect(keepsRowsWhileSwitching({ ...base, status: 'error' })).toBe(false);
  });

  it('数据已经到了（ready）就不再算切换中', () => {
    expect(keepsRowsWhileSwitching({ ...base, status: 'ready' })).toBe(false);
  });
});
