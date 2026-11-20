'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/main/store');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-store-test-'));
}

function hashOf(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest('hex');
}

function makeTextItem(seed, extra = {}) {
  return {
    id: `id-${seed}`,
    type: 'text',
    createdAt: 1000 + seed,
    hash: hashOf(`seed-${seed}`),
    text: `文本内容 ${seed}`,
    pinned: false,
    pinnedAt: null,
    ...extra,
  };
}

test('store: 首次加载为空，保存后可重新读取', async () => {
  const dir = makeTempDir();
  try {
    const store = new Store({ dataDir: dir });
    const result = await store.load();
    assert.deepEqual(result.warnings, []);
    assert.equal(store.state.items.length, 0);

    store.state.items.push(makeTextItem(1));
    store.markDirty();
    await store.flush();
    assert.ok(fs.existsSync(path.join(dir, 'index.json')));

    const reopened = new Store({ dataDir: dir });
    await reopened.load();
    assert.equal(reopened.state.items.length, 1);
    assert.equal(reopened.state.items[0].id, 'id-1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: 第二次保存会生成上一版本的 .bak 备份', async () => {
  const dir = makeTempDir();
  try {
    const store = new Store({ dataDir: dir });
    await store.load();

    store.state.items.push(makeTextItem(1));
    store.markDirty();
    await store.flush();

    store.state.items.push(makeTextItem(2));
    store.markDirty();
    await store.flush();

    const backup = JSON.parse(fs.readFileSync(path.join(dir, 'index.json.bak'), 'utf8'));
    const current = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    assert.equal(backup.items.length, 1);
    assert.equal(current.items.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: 主文件损坏时从 .bak 恢复并隔离损坏文件', async () => {
  const dir = makeTempDir();
  try {
    const store = new Store({ dataDir: dir });
    await store.load();
    store.state.items.push(makeTextItem(1));
    store.markDirty();
    await store.flush();
    store.state.items.push(makeTextItem(2));
    store.markDirty();
    await store.flush();

    fs.writeFileSync(path.join(dir, 'index.json'), '{broken json', 'utf8');

    const reopened = new Store({ dataDir: dir });
    const result = await reopened.load();
    assert.equal(reopened.state.items.length, 1);
    assert.ok(result.warnings.length >= 1);
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('index.corrupt-')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: 主文件与备份都损坏时以空数据启动并隔离两个文件', async () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'index.json'), 'not json', 'utf8');
    fs.writeFileSync(path.join(dir, 'index.json.bak'), 'also not json', 'utf8');

    const store = new Store({ dataDir: dir });
    const result = await store.load();
    assert.equal(store.state.items.length, 0);
    assert.ok(result.warnings.length >= 1);
    assert.ok(fs.readdirSync(dir).filter((name) => name.includes('.corrupt-')).length >= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: 跳过非法条目并留档', async () => {
  const dir = makeTempDir();
  try {
    const payload = {
      schemaVersion: 1,
      items: [makeTextItem(1), { bad: true }],
    };
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(payload), 'utf8');

    const store = new Store({ dataDir: dir });
    const result = await store.load();
    assert.equal(store.state.items.length, 1);
    assert.ok(result.warnings.some((warning) => warning.includes('无法识别')));
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('index.invalid-')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: 数据版本高于程序支持版本时拒绝加载', async () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ schemaVersion: 3, items: [] }), 'utf8');
    const store = new Store({ dataDir: dir });
    await assert.rejects(store.load(), (err) => err.code === 'FUTURE_SCHEMA');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: v1 数据自动迁移到 v2 并保存', async () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'index.json'),
      JSON.stringify({ schemaVersion: 1, items: [makeTextItem(1)] }),
      'utf8'
    );
    const store = new Store({ dataDir: dir });
    await store.load();
    assert.equal(store.state.schemaVersion, 2);
    assert.equal(store.state.items.length, 1);
    assert.equal(store.dirty, true);

    await store.flush();
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    assert.equal(parsed.schemaVersion, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: 写入失败时保持 dirty 并抛出', async () => {
  const dir = makeTempDir();
  try {
    const store = new Store({ dataDir: dir });
    await store.load();
    store.state.items.push(makeTextItem(1));
    store.markDirty();

    // 把临时文件路径变成目录，迫使写入失败
    fs.mkdirSync(path.join(dir, 'index.json.tmp'));

    await assert.rejects(store.flush());
    assert.equal(store.dirty, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: syncBackup 写入后备份与主文件一致', async () => {
  const dir = makeTempDir();
  try {
    const store = new Store({ dataDir: dir });
    await store.load();
    store.state.items.push(makeTextItem(1), makeTextItem(2));
    store.markDirty();
    await store.flush();

    store.state.items = store.state.items.filter((item) => item.id === 'id-2');
    store.markDirty();
    await store.flush({ syncBackup: true });

    const backup = JSON.parse(fs.readFileSync(path.join(dir, 'index.json.bak'), 'utf8'));
    assert.equal(backup.items.length, 1);
    assert.equal(backup.items[0].id, 'id-2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
