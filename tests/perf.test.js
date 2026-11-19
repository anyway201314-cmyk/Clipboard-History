'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/main/store');

function hashOf(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest('hex');
}

test('perf: 3000 条索引保存与加载耗时', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-perf-test-'));
  try {
    const store = new Store({ dataDir: dir });
    await store.load();

    const baseTime = Date.now();
    for (let i = 0; i < 3000; i += 1) {
      store.state.items.push({
        id: `id-${i}`,
        type: 'text',
        createdAt: baseTime + i,
        hash: hashOf(`perf-${i}`),
        text: `性能测试文本 ${i} ${'x'.repeat(60)}`,
        pinned: false,
        pinnedAt: null,
      });
    }
    store.markDirty();

    const saveStart = process.hrtime.bigint();
    await store.flush();
    const saveMs = Number(process.hrtime.bigint() - saveStart) / 1e6;

    const loadStart = process.hrtime.bigint();
    const reopened = new Store({ dataDir: dir });
    await reopened.load();
    const loadMs = Number(process.hrtime.bigint() - loadStart) / 1e6;

    const size = fs.statSync(path.join(dir, 'index.json')).size;
    console.log(
      `[perf] 3000 条：保存 ${saveMs.toFixed(1)}ms，加载 ${loadMs.toFixed(1)}ms，体积 ${(size / 1024 / 1024).toFixed(2)}MB`
    );

    assert.equal(reopened.state.items.length, 3000);
    assert.ok(saveMs < 2000, `保存耗时异常：${saveMs}ms`);
    assert.ok(loadMs < 1000, `加载耗时异常：${loadMs}ms`);
    assert.ok(size < 30 * 1024 * 1024);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
