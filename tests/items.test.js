'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ItemService, DAY_MS, sha256 } = require('../src/main/items');

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-items-test-'));
  const imagesDir = path.join(dir, 'images');
  const thumbsDir = path.join(dir, 'thumbs');
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });
  const store = {
    state: { schemaVersion: 1, items: [] },
    dirtyCount: 0,
    markDirty() {
      this.dirtyCount += 1;
    },
  };
  const logger = { info() {}, warn() {}, error() {} };
  const service = new ItemService({ store, imagesDir, thumbsDir, logger });
  return { dir, store, service, imagesDir, thumbsDir };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function ingestImage(service, seed, now, width = 100, height = 80) {
  const buffer = Buffer.from(`image-bytes-${seed}`);
  return service.ingestImage({
    buffer,
    hash: sha256(buffer),
    thumbBuffer: Buffer.from(`thumb-${seed}`),
    width,
    height,
    now,
  });
}

test('items: 文本入库与去重更新时间', () => {
  const { dir, service } = makeService();
  try {
    const first = service.ingestText('你好，世界', 1000);
    assert.equal(first.ok, true);
    assert.equal(first.updated, false);
    assert.equal(service.items.length, 1);

    const second = service.ingestText('你好，世界', 2000);
    assert.equal(second.ok, true);
    assert.equal(second.updated, true);
    assert.equal(service.items.length, 1);
    assert.equal(service.items[0].createdAt, 2000);
    assert.equal(service.items[0].hash, first.item.hash);
  } finally {
    cleanup(dir);
  }
});

test('items: 图片入库、文件落盘与去重', () => {
  const { dir, service, imagesDir, thumbsDir } = makeService();
  try {
    const first = ingestImage(service, 'a', 1000);
    assert.equal(first.ok, true);
    const file = first.item.image.file;
    assert.ok(fs.existsSync(path.join(imagesDir, file)));
    assert.ok(fs.existsSync(path.join(thumbsDir, first.item.image.thumb)));

    const second = ingestImage(service, 'a', 2000);
    assert.equal(second.updated, true);
    assert.equal(service.items.length, 1);
    assert.equal(service.items[0].createdAt, 2000);
  } finally {
    cleanup(dir);
  }
});

test('items: 置顶排序与取消置顶', () => {
  const { dir, service } = makeService();
  try {
    service.ingestText('第一条', 1000);
    service.ingestText('第二条', 2000);
    const firstId = service.items[0].id;

    service.setPinned(firstId, true, 3000);
    let result = service.query({});
    assert.equal(result.items[0].id, firstId);
    assert.equal(result.items[0].pinned, true);

    service.setPinned(firstId, false, 4000);
    result = service.query({});
    assert.equal(result.items[0].previewText, '第二条');
  } finally {
    cleanup(dir);
  }
});

test('items: 过期清理保留置顶并删除图片文件', () => {
  const { dir, service, imagesDir } = makeService();
  try {
    const now = 100 * DAY_MS;
    const oldText = service.ingestText('旧文本', now - 10 * DAY_MS).item;
    const pinned = service.ingestText('置顶旧文本', now - 10 * DAY_MS).item;
    service.setPinned(pinned.id, true, now - 9 * DAY_MS);
    service.ingestText('新文本', now - 1 * DAY_MS);
    const oldImage = ingestImage(service, 'old', now - 10 * DAY_MS).item;

    const result = service.prune({ retentionDays: 7, now });
    assert.equal(result.removed, 2);
    assert.ok(!service.findById(oldText.id));
    assert.ok(!service.findById(oldImage.id));
    assert.ok(service.findById(pinned.id));
    assert.equal(service.items.length, 2);
    assert.ok(!fs.existsSync(path.join(imagesDir, oldImage.image.file)));
  } finally {
    cleanup(dir);
  }
});

test('items: 超过 5000 条时裁剪最旧的非置顶记录', () => {
  const { dir, service } = makeService();
  try {
    // 绕过 ingest 的即时裁剪，直接构造 5010 条以验证 prune 的上限裁剪逻辑
    for (let i = 0; i < 5010; i += 1) {
      service.items.push({
        id: `cap-${i}`,
        type: 'text',
        createdAt: 1000 + i,
        hash: sha256(Buffer.from(`cap-${i}`)),
        text: `记录-${i}`,
        pinned: false,
        pinnedAt: null,
      });
    }
    const result = service.prune({ retentionDays: 30, now: 10000 });
    assert.equal(service.items.length, 5000);
    assert.equal(result.trimmed, 10);
    assert.equal(service.items.find((item) => item.text === '记录-0'), undefined);
    assert.ok(service.items.find((item) => item.text === '记录-10'));
  } finally {
    cleanup(dir);
  }
});

test('items: 搜索全文、大小写、中文与图片排除', () => {
  const { dir, service } = makeService();
  try {
    const longText = `${'a'.repeat(600)}KEYWORD-END`;
    service.ingestText(longText, 1000);
    service.ingestText('MixedCase Apple', 2000);
    service.ingestText('中文关键词测试', 3000);
    ingestImage(service, 'search-img', 4000);

    assert.equal(service.query({ search: 'keyword-end' }).total, 1);
    assert.equal(service.query({ search: 'apple' }).total, 1);
    assert.equal(service.query({ search: '中文关键词' }).total, 1);
    assert.equal(service.query({ search: '' }).total, 4);
    assert.equal(service.query({ search: '不存在的内容' }).total, 0);

    const dto = service.query({ search: 'mixedcase' }).items[0];
    assert.ok(dto.previewText.length <= 500);
  } finally {
    cleanup(dir);
  }
});

test('items: 分页返回正确条目', () => {
  const { dir, service } = makeService();
  try {
    for (let i = 0; i < 5; i += 1) service.ingestText(`分页-${i}`, 1000 + i);
    const page = service.query({ offset: 1, limit: 2 });
    assert.equal(page.total, 5);
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0].previewText, '分页-3');
    assert.equal(page.items[1].previewText, '分页-2');
  } finally {
    cleanup(dir);
  }
});

test('items: 删除与清空（保留置顶、删除图片文件）', () => {
  const { dir, service, imagesDir } = makeService();
  try {
    const keep = service.ingestText('保留', 1000).item;
    service.setPinned(keep.id, true, 1500);
    const removeText = service.ingestText('删除文本', 2000).item;
    const removeImage = ingestImage(service, 'remove', 3000).item;

    assert.equal(service.remove(removeText.id).ok, true);
    assert.ok(!service.findById(removeText.id));

    const cleared = service.clearUnpinned();
    assert.equal(cleared.cleared, 1);
    assert.equal(service.items.length, 1);
    assert.equal(service.items[0].id, keep.id);
    assert.ok(!fs.existsSync(path.join(imagesDir, removeImage.image.file)));
  } finally {
    cleanup(dir);
  }
});

test('items: 孤儿图片清理', () => {
  const { dir, service, imagesDir, thumbsDir } = makeService();
  try {
    const image = ingestImage(service, 'keep', 1000).item;
    fs.writeFileSync(path.join(imagesDir, 'orphan.png'), 'x');
    fs.writeFileSync(path.join(thumbsDir, 'orphan.png'), 'x');

    const removed = service.cleanupOrphanFiles();
    assert.equal(removed, 2);
    assert.ok(fs.existsSync(path.join(imagesDir, image.image.file)));
    assert.ok(!fs.existsSync(path.join(imagesDir, 'orphan.png')));
  } finally {
    cleanup(dir);
  }
});

test('items: 统计与到期待清理数量', () => {
  const { dir, service } = makeService();
  try {
    const now = 10 * DAY_MS;
    service.ingestText('旧', now - 8 * DAY_MS);
    const pinned = service.ingestText('旧置顶', now - 8 * DAY_MS).item;
    service.setPinned(pinned.id, true, now - 7 * DAY_MS);
    ingestImage(service, 'stats', now - 1 * DAY_MS);

    assert.equal(service.countDueForRetention(7, now), 1);
    const stats = service.stats();
    assert.deepEqual(stats, { total: 3, texts: 2, images: 1, pinned: 1 });
  } finally {
    cleanup(dir);
  }
});
