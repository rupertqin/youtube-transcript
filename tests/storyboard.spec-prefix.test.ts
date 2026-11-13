import { describe, expect, it } from 'vitest';
import { frameAt } from '../src/core/storyboard';

/**
 * storyboard spec 解析。
 *
 * 两件事必须与 YouTube 自己的实现一致（参考 YouTube.js 的 PlayerStoryboardSpec）：
 *   ① 每档 URL 要拼回该档自己的 `?sigh=` —— 少了它 i.ytimg.com 直接 401/404，
 *      表现就是「章节截图全是空白」；
 *   ② `$L` 是**原始段序号**（0 起），不是「第几个解析成功的档位」。
 */

const TEMPLATE = 'https://i.ytimg.com/sb/abc/storyboard3_L$L/$N.jpg?sqp=AA';

/** 真实响应里的四档：0 档 interval=0（整段海报），1~3 档可按时间取帧。 */
const REAL = `${TEMPLATE}|48#27#100#10#10#0#default#sigh0`
  + '|80#45#101#10#10#1000#M$M#sigh1'
  + '|160#90#101#10#10#2000#M$M#sigh2'
  + '|320#180#101#3#3#4000#M$M#sigh3';

describe('storyboard 签名参数', () => {
  it('URL 必须带该档自己的 sigh，否则图永远空白', () => {
    // 212s → 第 212 帧 → 第 2 张图集 → col 2 / row 1
    expect(frameAt(REAL, 212000)?.url).toBe(
      'https://i.ytimg.com/sb/abc/storyboard3_L1/M2.jpg?sqp=AA&sigh=sigh1',
    );
  });

  it('用的是选中档位的 sigh，不是第 0 档的', () => {
    const url = frameAt(REAL, 212000)?.url ?? '';
    expect(url).toContain('sigh=sigh1');
    expect(url).not.toContain('sigh0');
  });

  it('间隔为 0 的档位（整段海报）不参与按时间取帧', () => {
    // 0 档 interval=0、宽 48；能用的最小档是 80，所以 $L 必须是 1
    expect(frameAt(REAL, 0)?.url).toContain('storyboard3_L1/');
  });
});

describe('storyboard $L 与 $M', () => {
  it('$L 用原始段序号：中间有解析不出来的段时不回退', () => {
    // 第 1 段是占位符（缺字段），第 2 段才是 80 宽的档位
    const spec = `${TEMPLATE}|48#27#100#10#10#0#default#s0|$M`
      + '|80#45#101#10#10#1000#M$M#s2';
    // 与 YouTube 的解析一致：这一档的段序号是 2
    expect(frameAt(spec, 212000)?.url).toBe(
      'https://i.ytimg.com/sb/abc/storyboard3_L2/M2.jpg?sqp=AA&sigh=s2',
    );
  });

  it('$M 换成图集序号（第 3 张图集）', () => {
    // 2120s → 2120 帧 → 第 21 张图集
    expect(frameAt(REAL, 2120000)?.url).toBe(
      'https://i.ytimg.com/sb/abc/storyboard3_L1/M21.jpg?sqp=AA&sigh=sigh1',
    );
  });

  it('缺 sigh 字段（只有 6 段）时不追加该参数，仍能出图', () => {
    const short = `${TEMPLATE}|48#27#100#10#10#0|80#45#101#10#10#1000`;
    const frame = frameAt(short, 212000);
    expect(frame?.url).toBe('https://i.ytimg.com/sb/abc/storyboard3_L1/default.jpg?sqp=AA');
    expect(frame?.url).not.toContain('sigh');
  });
});

describe('storyboard 裁切几何', () => {
  it('宽、高、偏移共用同一个 scale，避免跨行串帧', () => {
    const frame = frameAt(REAL, 212000);
    expect(frame).not.toBeNull();
    // 45px 高按 56/80 缩放是 31.5，浮点会有尾数，按精度比较
    expect(frame!.width).toBe(56);
    expect(frame!.height).toBeCloseTo(31.5, 5);
    expect(frame!.offsetX).toBe(-112);
    expect(frame!.offsetY).toBeCloseTo(-31.5, 5);
    expect(frame!.sheetWidth).toBe(560);
    expect(frame!.sheetHeight).toBeCloseTo(315, 5);
  });

  it('spec 为空或不可解析时返回 null，不产生错位图', () => {
    expect(frameAt(null, 1000)).toBeNull();
    expect(frameAt('', 1000)).toBeNull();
    expect(frameAt('https://i.ytimg.com/sb/abc/x.jpg?sqp=AA', 1000)).toBeNull();
  });
});
