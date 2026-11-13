import { describe, expect, it } from 'vitest';
import { frameAt } from '../src/core/storyboard';

/**
 * 真实 spec 形如（截取两档）：
 *   https://i.ytimg.com/sb/ID/storyboard3_L$L/$N.jpg?sqp=…|48#27#100#10#10#0#default#sig|80#45#100#10#10#2000#M$M#sig
 * 第 0 档 interval=0，是整段海报，不能按时间定位。
 */
const SPEC =
  'https://i.ytimg.com/sb/abc/storyboard3_L$L/$N.jpg?sqp=x|48#27#100#10#10#0#default#sig|' +
  '80#45#100#10#10#2000#M$M#sig|160#90#100#10#10#2000#M$M#sig';

describe('storyboard 取帧', () => {
  it('按时间点算出正确的图集与偏移', () => {
    // 第 0 帧：第一张图集，左上角
    const first = frameAt(SPEC, 0);
    expect(first).not.toBeNull();
    expect(first!.url).toBe('https://i.ytimg.com/sb/abc/storyboard3_L1/M0.jpg?sqp=x');
    expect(first!.offsetX).toBe(0);
    expect(first!.offsetY).toBe(0);

    // 2000ms = 第 1 帧 → 第一行第二列
    const second = frameAt(SPEC, 2000);
    expect(second!.offsetX).toBeLessThan(0);
    expect(second!.offsetY).toBe(0);

    // 第 10 帧 → 第二行第一列（10 列一行）
    const row2 = frameAt(SPEC, 20_000);
    expect(row2!.offsetX).toBe(0);
    expect(row2!.offsetY).toBeLessThan(0);
  });

  it('跨图集时换 $N', () => {
    // 一张图集 10*10=100 帧，每帧 2000ms → 200s 后进入第二张图集
    const next = frameAt(SPEC, 200_000);
    expect(next!.url).toContain('/M1.jpg');
    expect(next!.offsetX).toBe(0);
    expect(next!.offsetY).toBe(0);
  });

  it('跳过 interval=0 的档位（整段海报不能定位）', () => {
    const frame = frameAt(SPEC, 0);
    // 选中的是 L1（80 宽，最接近 56 的显示宽度），不是 L0
    expect(frame!.url).toContain('storyboard3_L1/');
  });

  it('宽高与图集尺寸共用同一个缩放比例（否则裁切会错行）', () => {
    const frame = frameAt(SPEC, 0)!;
    const scale = 56 / 80;
    expect(frame.width).toBe(56);
    expect(frame.height).toBeCloseTo(frame.height, 5);
    expect(frame.height / frame.width).toBeCloseTo(45 / 80, 5);
    expect(frame.sheetWidth).toBeCloseTo(10 * 80 * scale, 5);
    expect(frame.sheetHeight).toBeCloseTo(10 * 45 * scale, 5);
    // 行高 × 行数 必须正好等于图集高度，不能有半行误差
    expect(frame.sheetHeight).toBeCloseTo(frame.height * 10, 5);
  });

  it('规格缺失或畸形时安全返回 null', () => {
    expect(frameAt(null, 0)).toBeNull();
    expect(frameAt('', 0)).toBeNull();
    expect(frameAt('https://x/y.jpg|bad', 0)).toBeNull();
    expect(frameAt(SPEC, -1)).toBeNull();
    // 只有 interval=0 的档位 → 无从定位
    expect(frameAt('https://i.ytimg.com/sb/a/storyboard3_L$L/$N.jpg|48#27#100#10#10#0#default#s', 0)).toBeNull();
  });
});
