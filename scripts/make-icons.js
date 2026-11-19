'use strict';

// 纯 Node 生成图标（无第三方依赖）：托盘 16/32、应用 256 及多尺寸 ICO。
// 用法：node scripts/make-icons.js

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const BUILD = path.join(ROOT, 'build');

const COLORS = {
  bg: [11, 30, 54, 255], // #0B1E36
  light: [232, 238, 247, 255], // #E8EEF7
  accent: [76, 141, 255, 255], // #4C8DFF
};

// ---------- PNG 编码 ----------

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
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 光栅化（4x 超采样抗锯齿） ----------

const SS = 4;

function createCanvas(w, h) {
  return { w, h, data: Buffer.alloc(w * h * 4) };
}

function blendPixel(canvas, x, y, color) {
  if (x < 0 || y < 0 || x >= canvas.w || y >= canvas.h) return;
  const i = (y * canvas.w + x) * 4;
  const a = color[3] / 255;
  if (a <= 0) return;
  const inv = 1 - a;
  canvas.data[i] = Math.round(color[0] * a + canvas.data[i] * inv);
  canvas.data[i + 1] = Math.round(color[1] * a + canvas.data[i + 1] * inv);
  canvas.data[i + 2] = Math.round(color[2] * a + canvas.data[i + 2] * inv);
  canvas.data[i + 3] = Math.round(color[3] + canvas.data[i + 3] * inv);
}

function insideRounded(cx, cy, x0, y0, x1, y1, r) {
  if (cx < x0 || cx > x1 || cy < y0 || cy > y1) return false;
  const rx = Math.min(r, (x1 - x0) / 2);
  const ry = Math.min(r, (y1 - y0) / 2);
  if (cx >= x0 + rx && cx <= x1 - rx) return true;
  if (cy >= y0 + ry && cy <= y1 - ry) return true;
  const cornerX = cx < x0 + rx ? x0 + rx : x1 - rx;
  const cornerY = cy < y0 + ry ? y0 + ry : y1 - ry;
  const dx = (cx - cornerX) / rx;
  const dy = (cy - cornerY) / ry;
  return dx * dx + dy * dy <= 1;
}

function fillRoundedRect(canvas, x0, y0, x1, y1, radius, color) {
  const startX = Math.max(0, Math.floor(x0));
  const endX = Math.min(canvas.w - 1, Math.ceil(x1));
  const startY = Math.max(0, Math.floor(y0));
  const endY = Math.min(canvas.h - 1, Math.ceil(y1));
  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      if (insideRounded(x + 0.5, y + 0.5, x0, y0, x1, y1, radius)) {
        blendPixel(canvas, x, y, color);
      }
    }
  }
}

function eraseRoundedRect(canvas, x0, y0, x1, y1, radius) {
  const startX = Math.max(0, Math.floor(x0));
  const endX = Math.min(canvas.w - 1, Math.ceil(x1));
  const startY = Math.max(0, Math.floor(y0));
  const endY = Math.min(canvas.h - 1, Math.ceil(y1));
  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      if (insideRounded(x + 0.5, y + 0.5, x0, y0, x1, y1, radius)) {
        const i = (y * canvas.w + x) * 4;
        canvas.data[i] = 0;
        canvas.data[i + 1] = 0;
        canvas.data[i + 2] = 0;
        canvas.data[i + 3] = 0;
      }
    }
  }
}

function downsample(canvas, factor) {
  const w = Math.floor(canvas.w / factor);
  const h = Math.floor(canvas.h / factor);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let sumA = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const i = ((y * factor + sy) * canvas.w + (x * factor + sx)) * 4;
          const a = canvas.data[i + 3];
          sumA += a;
          sumR += canvas.data[i] * a;
          sumG += canvas.data[i + 1] * a;
          sumB += canvas.data[i + 2] * a;
        }
      }
      const o = (y * w + x) * 4;
      const n = factor * factor;
      out[o + 3] = Math.round(sumA / n);
      if (sumA > 0) {
        out[o] = Math.round(sumR / sumA);
        out[o + 1] = Math.round(sumG / sumA);
        out[o + 2] = Math.round(sumB / sumA);
      }
    }
  }
  return { w, h, data: out };
}

// ---------- 图形绘制 ----------

function drawTray(size) {
  const s = size * SS;
  const canvas = createCanvas(s, s);
  const u = (v) => v * s;

  // 剪贴板主体
  fillRoundedRect(canvas, u(0.22), u(0.14), u(0.78), u(0.9), u(0.08), COLORS.light);
  // 顶部夹子
  fillRoundedRect(canvas, u(0.4), u(0.04), u(0.6), u(0.2), u(0.04), COLORS.light);
  // 三条镂空横线（显出背景色，形成“内容”纹理）
  eraseRoundedRect(canvas, u(0.32), u(0.36), u(0.68), u(0.42), u(0.02));
  eraseRoundedRect(canvas, u(0.32), u(0.5), u(0.68), u(0.56), u(0.02));
  eraseRoundedRect(canvas, u(0.32), u(0.64), u(0.68), u(0.7), u(0.02));

  return downsample(canvas, SS);
}

function drawAppIcon(size) {
  const s = size * SS;
  const canvas = createCanvas(s, s);
  const u = (v) => v * s;

  // 深蓝圆角底
  fillRoundedRect(canvas, 0, 0, s, s, u(0.22), COLORS.bg);
  // 剪贴板主体
  fillRoundedRect(canvas, u(0.25), u(0.17), u(0.75), u(0.83), u(0.06), COLORS.light);
  // 顶部夹子
  fillRoundedRect(canvas, u(0.4), u(0.07), u(0.6), u(0.23), u(0.04), COLORS.light);
  // 三条强调色横线
  fillRoundedRect(canvas, u(0.33), u(0.38), u(0.67), u(0.43), u(0.02), COLORS.accent);
  fillRoundedRect(canvas, u(0.33), u(0.52), u(0.67), u(0.57), u(0.02), COLORS.accent);
  fillRoundedRect(canvas, u(0.33), u(0.66), u(0.67), u(0.71), u(0.02), COLORS.accent);

  return downsample(canvas, SS);
}

// ---------- ICO 编码 ----------

function encodeICO(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const entries = [];
  const blobs = [];
  let offset = 6 + 16 * count;

  for (const { size, png } of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    blobs.push(png);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...blobs]);
}

// ---------- 输出 ----------

function writePNG(file, image) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePNG(image.w, image.h, image.data));
  console.log(`已生成 ${path.relative(ROOT, file)} (${image.w}x${image.h})`);
}

fs.mkdirSync(ASSETS, { recursive: true });
fs.mkdirSync(BUILD, { recursive: true });

writePNG(path.join(ASSETS, 'tray-16.png'), drawTray(16));
writePNG(path.join(ASSETS, 'tray-32.png'), drawTray(32));
writePNG(path.join(ASSETS, 'app-icon.png'), drawAppIcon(256));
writePNG(path.join(BUILD, 'icon.png'), drawAppIcon(256));

const icoSizes = [16, 32, 48, 64, 128, 256];
const icoPngs = icoSizes.map((size) => ({ size, png: encodePNG(size, size, drawAppIcon(size).data) }));
fs.writeFileSync(path.join(BUILD, 'icon.ico'), encodeICO(icoPngs));
console.log(`已生成 ${path.relative(ROOT, path.join(BUILD, 'icon.ico'))}（${icoSizes.join('/')} 多尺寸）`);
