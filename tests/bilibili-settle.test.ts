import { describe, expect, it } from 'vitest';
import { createSettleGate } from '../src/core/site/bilibili/index';

/**
 * 「能不能往 B 站页面里插节点」的时机判定。
 *
 * 判早了：Vue 还在 hydration，插进去的节点会让 B 站自己的 app 抛
 * HierarchyRequestError，页头（登录态）跟着失效。
 * 判晚了 / 永远不放行：按钮和卡片都不出现（这条同样踩过）。
 */
function fakeDoc(state: { readyState: Document['readyState']; ssrAttr: boolean }): Document {
  return {
    get readyState() {
      return state.readyState;
    },
    querySelector: (selector: string) => (state.ssrAttr && selector === '[data-server-rendered]' ? {} : null),
  } as unknown as Document;
}

describe('createSettleGate', () => {
  it('文档还在加载时一律不放行', () => {
    let t = 0;
    const state = { readyState: 'loading' as Document['readyState'], ssrAttr: true };
    const gate = createSettleGate(fakeDoc(state), () => t);
    expect(gate()).toBe(false);
    t += 10_000;
    expect(gate()).toBe(false);
  });

  it('SSR 属性消失后还要静置 1s 才放行', () => {
    let t = 0;
    const state = { readyState: 'complete' as Document['readyState'], ssrAttr: true };
    const gate = createSettleGate(fakeDoc(state), () => t);
    expect(gate()).toBe(false); // 记下 loadedAt
    state.ssrAttr = false;
    t += 500;
    expect(gate()).toBe(false); // 记下 settledAt
    t += 999;
    expect(gate()).toBe(false);
    t += 1;
    expect(gate()).toBe(true);
  });

  it('属性一直不消失时，load 完成 6s 也必须放行（否则 UI 永远不出现）', () => {
    let t = 0;
    const state = { readyState: 'complete' as Document['readyState'], ssrAttr: true };
    const gate = createSettleGate(fakeDoc(state), () => t);
    expect(gate()).toBe(false);
    t += 5999;
    expect(gate()).toBe(false);
    t += 1;
    expect(gate()).toBe(true);
  });
});
