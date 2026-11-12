/**
 * 零依赖图标生成器：手写 PNG 编码（RGBA + zlib），4x 超采样做抗锯齿。
 * 输出 public/icon/{16,32,48,128}.png，供 manifest 与商店使用。
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

/** 在 1x1 单位坐标里描述图标：左上 #FF4E45 → 右下 #FF7A45 的圆角方块 + 三条白色字幕行 */
function sample(u, v) {
  const pad = 0.045;
  const x = u - pad;
  const y = v - pad;
  const size = 1 - pad * 2;
  if (x < 0 || y < 0 || x > size || y > size) return null;
  if (!roundedRectContains(x, y, size, size, size * 0.26)) return null;

  const t = (x / size) * 0.55 + (y / size) * 0.45;
  const bg = [
    Math.round(lerp(0xff, 0xff, t)),
    Math.round(lerp(0x4e, 0x7a, t)),
    Math.round(lerp(0x45, 0x45, t)),
  ];

  // 三条字幕行：上两条等长，最后一条短（视觉上像 transcript 的收尾）
  const bars = [
    { top: 0.3, width: 0.44, alpha: 1 },
    { top: 0.44, width: 0.44, alpha: 0.92 },
    { top: 0.58, width: 0.24, alpha: 0.72 },
  ];
  const barHeight = 0.075;
  const left = 0.22;
  for (const bar of bars) {
    const top = size * bar.top;
    const bottom = top + size * barHeight;
    const right = left + size * bar.width;
    if (x >= left && x <= right && y >= top && y <= bottom) {
      const mix = bar.alpha;
      return [
        Math.round(lerp(bg[0], 255, mix)),
        Math.round(lerp(bg[1], 255, mix)),
        Math.round(lerp(bg[2], 255, mix)),
      ];
    }
  }
  return bg;
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
