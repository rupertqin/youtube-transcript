import { describe, expect, it } from 'vitest';
import { frameAt } from '../src/core/storyboard';

/**
 * 真实 spec 的 URL 后面常常挂着一个非档位段（`$M` 签名占位）。
 * 用「段号」当 $L 会整体偏一位 → 请求不存在的 L2/M2.jpg → 缩略图全空。
 */
const WITH_SIG = 'https://i.ytimg.com/sb/abc/storyboard3_L$L/$N.jpg?sqp=AA|$M|'
  + '48#27#100#10#10#0#default#sig|80#45#101#10#10#1000#M$M#sig|'
  + '160#90#101#10#10#2000#M$M#sig';

const PLAIN = 'https://i.ytimg.com/sb/abc/storyboard3_L$L/$N.jpg?sqp=AA|'
  + '48#27#100#10#10#0#default#sig|80#45#101#10#10#1000#M$M#sig|'
  + '160#90#101#10#10#2000#M$M#sig';

describe('storyboard 前置签名段', () => {
  it('带 |$M| 段时 $L 仍指向正确档位', () => {
    expect(frameAt(WITH_SIG, 212000)?.url).toBe(
      'https://i.ytimg.com/sb/abc/storyboard3_L1/M2.jpg?sqp=AA',
    );
    expect(frameAt(WITH_SIG, 1694000)?.url).toBe(
      'https://i.ytimg.com/sb/abc/storyboard3_L1/M16.jpg?sqp=AA',
    );
  });

  it('两种 spec 取帧结果必须一致', () => {
    for (const ms of [0, 212000, 1694000]) {
      expect(frameAt(WITH_SIG, ms)).toEqual(frameAt(PLAIN, ms));
    }
  });

  it('档位只有 6 段（缺 name/sigh）时仍可用 default', () => {
    const short = 'https://i.ytimg.com/sb/abc/storyboard3_L$L/$N.jpg?sqp=AA|'
      + '48#27#100#10#10#0|80#45#101#10#10#1000';
    expect(frameAt(short, 212000)?.url).toBe(
      'https://i.ytimg.com/sb/abc/storyboard3_L1/default.jpg?sqp=AA',
    );
  });
});
