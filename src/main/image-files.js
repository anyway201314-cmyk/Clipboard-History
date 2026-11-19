'use strict';

// 图片预处理（依赖 Electron nativeImage）：解码、取尺寸、生成缩略图 PNG。
// 文件写入与元数据由 items.js 负责。

const { nativeImage } = require('electron');

const THUMB_MAX_WIDTH = 320;

function prepareImage(buffer) {
  try {
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    const thumb = width > THUMB_MAX_WIDTH ? image.resize({ width: THUMB_MAX_WIDTH, quality: 'good' }) : image;
    return { width, height, thumbBuffer: thumb.toPNG() };
  } catch {
    return null;
  }
}

module.exports = { prepareImage, THUMB_MAX_WIDTH };
