/**
 * 零依赖图标生成器：手写 PNG 编码（RGBA + zlib），4x 超采样做抗锯齿。
 * 输出 public/icon/{16,32,48,128}.png，供 manifest 与商店使用。
 *
 * 图形：圆角红底 + 白色汉字 **字**（字幕 / 文稿的直白符号）。
 * 用等宽圆头笔画拼出「宀 + 子」，笔画比原字母 Y 稍细，避免小尺寸糊成一团；
 * 红底圆角方块保留原有家族感，字形本身承担品牌识别。
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

/** 点到线段的最短距离：把每笔当成圆头胶囊。 */
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
const STROKE_R = 0.038 * MARK; // 1.2px @16；再粗「宀」和「子」会粘在一起

/**
 * 小篆「字」：宀 + 子。
 *
 * 用曲线而不是直线拼，笔画末端自然带卷（宀的屋檐、子的钩）。
 * 坐标相对字框 0..1，采样前乘 MARK；上下留约 10% 安全边。
 */
const GLYPH = [
  // 宀：点 + 微拱屋顶 + 两条垂直边
  ['M', 0.50, 0.09],
  ['Q', 0.48, 0.12, 0.50, 0.15],
  ['M', 0.21, 0.45],
  ['L', 0.21, 0.39],
  ['Q', 0.21, 0.34, 0.27, 0.34],
  ['L', 0.73, 0.34],
  ['Q', 0.79, 0.34, 0.79, 0.39],
  ['L', 0.79, 0.45],

  // 子（小篆保留的婴儿意象）：大圆头 + 张开的手臂 + 身体
  ['O', 0.50, 0.62, 0.085, 0.07], // 子的大头（小篆仍保留的婴儿头部）
  ['M', 0.50, 0.55],
  ['C', 0.51, 0.68, 0.49, 0.78, 0.50, 0.85], // 身体（穿过头与手臂）
  ['C', 0.50, 0.89, 0.45, 0.90, 0.40, 0.89],
  ['L', 0.36, 0.87], // 下肢左钩
  ['M', 0.26, 0.76],
  ['Q', 0.50, 0.79, 0.74, 0.76], // 双臂（长横，穿过身体）
];

/** 把 M/L/Q/C 路径采样成线段集合，供 SDF 距离场使用。 */
function glyphSegments(commands) {
  const segments = [];
  let cursor = null;

  const lineTo = (x, y) => {
    if (cursor) segments.push([cursor[0], cursor[1], x, y]);
    cursor = [x, y];
  };

  for (const [cmd, ...args] of commands) {
    if (cmd === 'M') {
      cursor = [args[0], args[1]];
      continue;
    }
    if (cmd === 'L') {
      lineTo(args[0], args[1]);
      continue;
    }
    if (cmd === 'Q') {
      const [cx, cy, x, y] = args;
      const [x0, y0] = cursor;
      const steps = 12;
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const u = 1 - t;
        lineTo(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y);
      }
      continue;
    }
    if (cmd === 'O') {
      // 闭合椭圆：用小篆「子」的大头保留婴儿意象
      const [cx, cy, rx, ry] = args;
      const steps = 36;
      cursor = [cx + rx, cy];
      for (let i = 1; i <= steps; i += 1) {
        const angle = (i / steps) * Math.PI * 2;
        lineTo(cx + rx * Math.cos(angle), cy + ry * Math.sin(angle));
      }
      continue;
    }
    if (cmd === 'C') {
      const [c1x, c1y, c2x, c2y, x, y] = args;
      const [x0, y0] = cursor;
      const steps = 16;
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const u = 1 - t;
        lineTo(
          u ** 3 * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t ** 3 * x,
          u ** 3 * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t ** 3 * y,
        );
      }
    }
  }
  return segments;
}

const GLYPH_LINES = glyphSegments(GLYPH).map(([ax, ay, bx, by]) => [
  ax * MARK,
  ay * MARK,
  bx * MARK,
  by * MARK,
]);

/** 在 1x1 单位坐标里描述图标：对角渐变红底 + 白色「字」。 */
function sample(u, v) {
  const x = u - PAD;
  const y = v - PAD;
  if (x < 0 || y < 0 || x > MARK || y > MARK) return null;
  if (!roundedRectContains(x, y, MARK, MARK, MARK * 0.25)) return null;

  // 左上偏亮 → 右下偏暖，比纯红更有层次，又不离开原来的红橙家族
  const t = (x / MARK) * 0.5 + (y / MARK) * 0.5;
  for (const [ax, ay, bx, by] of GLYPH_LINES) {
    if (segmentDistance(x, y, ax, ay, bx, by) <= STROKE_R) {
      return [255, 255, 255];
    }
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
