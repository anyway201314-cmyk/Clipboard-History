'use strict';

// 生成开发用种子数据（默认写入 data-dev/seed，不影响 data-dev 根目录的真实开发数据）。
// 用法：node scripts/seed-dev-data.js [目标目录]

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('../src/main/store');

const COUNT = 3000;

function hashText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function main() {
  const target = process.argv[2] || path.join(__dirname, '..', 'data-dev', 'seed');
  fs.mkdirSync(path.join(target, 'images'), { recursive: true });
  fs.mkdirSync(path.join(target, 'thumbs'), { recursive: true });

  const store = new Store({ dataDir: target });
  await store.load();

  const now = Date.now();
  for (let i = 0; i < COUNT; i += 1) {
    const text = `种子数据 ${i}：这是用于性能与列表测试的文本内容。${'内容片段。'.repeat(3)} #${i}`;
    const pinned = i > 0 && i % 500 === 0;
    const createdAt = now - (COUNT - i) * 60 * 1000;
    store.state.items.push({
      id: crypto.randomUUID(),
      type: 'text',
      createdAt,
      hash: hashText(text),
      text,
      pinned,
      pinnedAt: pinned ? createdAt + 1 : null,
    });
  }

  store.markDirty();
  await store.flush();
  console.log(`已生成 ${COUNT} 条种子数据：${path.relative(process.cwd(), target) || target}`);
}

main().catch((err) => {
  console.error('生成种子数据失败：', err && err.message ? err.message : err);
  process.exit(1);
});
