/**
 * 零依赖图标生成器：手写 PNG 编码（RGBA + zlib），4x 超采样做抗锯齿。
 * 输出 public/icon/{16,32,48,128}.png，供 manifest 与商店使用。
 *
 * 图形：圆角红底 + 白色字母 **Y**（YouTube 的首字母）。
 * Y 由三段等宽圆头线段构成，叉口 90°，与播放键的箭头同向 ——
 * 红底圆角方块保留 YouTube 家族感，字母本身承担品牌识别。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icon');
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;

function roundedRectContains(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 点到线段的最短距离（用来把 Y 的三笔当成三个「圆头胶囊」）。 */
function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2));
  return Math.hypot(wx - vx * t, wy - vy * t);
}

const PAD = 0.035;
const MARK = 1 - PAD * 2;
const STROKE_R = 0.068; // 笔宽 0.136 —— 16px 下约 2px，再细就糊成一条

/**
 * Y 的三个端点（画布 0..1 坐标）。
 *
 * 叉口约 90°：左右两臂与竖直中轴各 45°，方向上就是播放键的箭头；
 * 叉口压在略高于视觉中心的位置（0.455），让上半部分的「张开」更醒目，
 * 收笔到 0.762 —— 整体在红底里上下各留约 1/4 的安全边。
 */
const FORK = { x: 0.5, y: 0.455 };
const ARMS = [
  [0.272, 0.245, FORK.x, FORK.y],
  [0.728, 0.245, FORK.x, FORK.y],
  [FORK.x, FORK.y, 0.5, 0.762],
];

/** 在 1x1 单位坐标里描述图标：对角渐变红底 + 白色 Y。 */
function sample(u, v) {
  const x = u - PAD;
  const y = v - PAD;
  if (x < 0 || y < 0 || x > MARK || y > MARK) return null;
  if (!roundedRectContains(x, y, MARK, MARK, MARK * 0.25)) return null;

  // 左上偏亮 → 右下偏暖，比纯红更有层次，又不离开 YouTube 的红
  const t = (x / MARK) * 0.5 + (y / MARK) * 0.5;
  for (const [ax, ay, bx, by] of ARMS) {
    if (segmentDistance(x, y, ax, ay, bx, by) <= STROKE_R) return [255, 255, 255];
  }

  return [
    Math.round(lerp(0xff, 0xff, t)),
    Math.round(lerp(0x27, 0x7a, t)),
    Math.round(lerp(0x40, 0x29, t)),
  ];
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const samples = SS * SS;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const u = (px + (sx + 0.5) / SS) / size;
          const v = (py + (sy + 0.5) / SS) / size;
          const c = sample(u, v);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 255;
          }
        }
      }
      const idx = (py * size + px) * 4;
      const cover = a / 255;
      if (cover > 0) {
        buf[idx] = Math.round(r / cover);
        buf[idx + 1] = Math.round(g / cover);
        buf[idx + 2] = Math.round(b / cover);
        buf[idx + 3] = Math.round(a / samples);
      }
    }
  }
  return encodePng(size, size, buf);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `${size}.png`);
  writeFileSync(file, render(size));
  process.stdout.write(`icon ${size}x${size} -> ${file}\n`);
}
