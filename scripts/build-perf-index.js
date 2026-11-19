'use strict';

// 生成性能测试索引：2900 条文字 + 100 条图片（复用已有缩略图文件），共 3000 条。
// 输出 data-dev/perf-seed.json，由手动/脚本换入 data-dev/index.json 后测试。
// 用法：node scripts/build-perf-index.js

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data-dev');
const CURRENT = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index.json'), 'utf8'));

const imageItem = CURRENT.items.find((item) => item.type === 'image');
if (!imageItem) {
  console.error('当前数据中没有图片记录，无法生成图片性能数据');
  process.exit(1);
}

const items = [];
const now = Date.now();
const TEXT_COUNT = 2900;
const IMAGE_COUNT = 100;

for (let i = 0; i < TEXT_COUNT; i += 1) {
  const text = `性能种子 ${i}：${'这是一条用于列表与搜索性能测试的文本。'.repeat(2)} 编号 ${i}`;
  const pinned = i > 0 && i % 700 === 0;
  const createdAt = now - i * 60 * 1000;
  items.push({
    id: crypto.randomUUID(),
    type: 'text',
    createdAt,
    hash: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    text,
    pinned,
    pinnedAt: pinned ? createdAt + 1 : null,
  });
}

for (let i = 0; i < IMAGE_COUNT; i += 1) {
  const createdAt = now - i * 120 * 1000 - 30 * 1000;
  items.push({
    id: crypto.randomUUID(),
    type: 'image',
    createdAt,
    hash: crypto.createHash('sha256').update(`perf-image-${i}`).digest('hex'),
    image: {
      file: imageItem.image.file,
      thumb: imageItem.image.thumb,
      width: imageItem.image.width,
      height: imageItem.image.height,
      size: imageItem.image.size,
    },
    pinned: false,
    pinnedAt: null,
  });
}

const output = { schemaVersion: 1, items };
const target = path.join(DATA_DIR, 'perf-seed.json');
fs.writeFileSync(target, JSON.stringify(output), 'utf8');
console.log(
  `已生成 ${items.length} 条性能数据（文字 ${TEXT_COUNT}，图片 ${IMAGE_COUNT}，置顶 ${items.filter((item) => item.pinned).length}）：${path.relative(ROOT, target)}`
);
