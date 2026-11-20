'use strict';

// 图片预处理（依赖 Electron nativeImage）：解码、取尺寸、生成缩略图 PNG，
// 并计算像素内容哈希（用于“同一张图重复复制”去重，不受 PNG 编码差异影响）。
// 文件写入与元数据由 items.js 负责。

const crypto = require('node:crypto');
const fs = require('node:fs');
const { nativeImage } = require('electron');

const THUMB_MAX_WIDTH = 320;

function pixelHashOfImage(image) {
  return crypto.createHash('sha256').update(image.toBitmap()).digest('hex');
}

function prepareImage(buffer) {
  try {
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    const thumb = width > THUMB_MAX_WIDTH ? image.resize({ width: THUMB_MAX_WIDTH, quality: 'good' }) : image;
    return {
      width,
      height,
      thumbBuffer: thumb.toPNG(),
      pixelHash: pixelHashOfImage(image),
    };
  } catch {
    return null;
  }
}

function pixelHashFromFile(filePath) {
  try {
    const image = nativeImage.createFromBuffer(fs.readFileSync(filePath));
    if (image.isEmpty()) return null;
    return pixelHashOfImage(image);
  } catch {
    return null;
  }
}

module.exports = { prepareImage, pixelHashFromFile, THUMB_MAX_WIDTH };
