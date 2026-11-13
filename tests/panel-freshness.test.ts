import { describe, expect, it } from 'vitest';
import { isStalePanelState } from '../src/ui/panel';

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
