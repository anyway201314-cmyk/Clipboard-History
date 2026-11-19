'use strict';

// 条目业务逻辑：入库、去重、置顶、删除、清空、过期清理、容量上限、搜索、分页 DTO。
// 纯 Node 实现（图片处理在 main 的 image-files.js 中完成），便于 node:test。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_TEXT_CHARS = 200000;
const MAX_ITEMS = 5000;
const PREVIEW_CHARS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isHexHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

class ItemService {
  constructor({ store, imagesDir, thumbsDir, logger }) {
    this.store = store;
    this.imagesDir = imagesDir;
    this.thumbsDir = thumbsDir;
    this.logger = logger || { info() {}, warn() {}, error() {} };
  }

  get items() {
    return this.store.state.items;
  }

  findById(id) {
    return this.items.find((item) => item.id === id);
  }

  findByHash(hash) {
    return this.items.find((item) => item.hash === hash);
  }

  ingestText(text, now = Date.now()) {
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { ok: false, reason: 'empty' };
    }
    if (text.length > MAX_TEXT_CHARS) {
      return { ok: false, reason: 'oversized' };
    }

    const hash = sha256(Buffer.from(text, 'utf8'));
    const existing = this.findByHash(hash);
    if (existing) {
      existing.createdAt = now;
      this.store.markDirty();
      return { ok: true, updated: true, item: existing };
    }

    const item = {
      id: crypto.randomUUID(),
      type: 'text',
      createdAt: now,
      hash,
      text,
      pinned: false,
      pinnedAt: null,
    };
    this.items.push(item);
    this.trimToMax();
    this.store.markDirty();
    return { ok: true, updated: false, item };
  }

  ingestImage({ buffer, hash, thumbBuffer, width, height, now = Date.now() }) {
    if (!Buffer.isBuffer(buffer) || !Buffer.isBuffer(thumbBuffer)) {
      return { ok: false, reason: 'bad-input' };
    }
    if (!isHexHash(hash)) {
      return { ok: false, reason: 'bad-hash' };
    }

    const file = `${hash}.png`;
    const thumb = `${hash}.png`;
    const imagePath = path.join(this.imagesDir, file);
    const thumbPath = path.join(this.thumbsDir, thumb);
    const existing = this.findByHash(hash);

    if (existing) {
      if (!fs.existsSync(imagePath) && !this.writeFileAtomic(imagePath, buffer)) {
        return { ok: false, reason: 'io' };
      }
      if (!fs.existsSync(thumbPath)) this.writeFileAtomic(thumbPath, thumbBuffer);
      existing.createdAt = now;
      this.store.markDirty();
      return { ok: true, updated: true, item: existing };
    }

    if (!this.writeFileAtomic(imagePath, buffer)) {
      return { ok: false, reason: 'io' };
    }
    if (!this.writeFileAtomic(thumbPath, thumbBuffer)) {
      return { ok: false, reason: 'io' };
    }

    const item = {
      id: crypto.randomUUID(),
      type: 'image',
      createdAt: now,
      hash,
      image: { file, thumb, width, height, size: buffer.length },
      pinned: false,
      pinnedAt: null,
    };
    this.items.push(item);
    this.trimToMax();
    this.store.markDirty();
    return { ok: true, updated: false, item };
  }

  writeFileAtomic(filePath, buffer) {
    const tmp = `${filePath}.tmp`;
    try {
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, filePath);
      return true;
    } catch (err) {
      this.logger.warn('items', `image file write failed: ${err && err.message ? err.message : err}`);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // 忽略
      }
      return false;
    }
  }

  setPinned(id, pinned, now = Date.now()) {
    const item = this.findById(id);
    if (!item) return { ok: false, error: '条目不存在' };
    item.pinned = Boolean(pinned);
    item.pinnedAt = item.pinned ? now : null;
    this.store.markDirty();
    return { ok: true, item };
  }

  remove(id) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return { ok: false, error: '条目不存在' };
    const [item] = this.items.splice(index, 1);
    this.deleteFilesFor(item);
    this.store.markDirty();
    return { ok: true, item };
  }

  clearUnpinned() {
    const kept = [];
    const removed = [];
    for (const item of this.items) {
      if (item.pinned) kept.push(item);
      else removed.push(item);
    }
    if (removed.length === 0) return { ok: true, cleared: 0 };

    this.store.state.items = kept;
    for (const item of removed) this.deleteFilesFor(item);
    this.store.markDirty();
    return { ok: true, cleared: removed.length };
  }

  countDueForRetention(retentionDays, now = Date.now()) {
    const cutoff = now - retentionDays * DAY_MS;
    return this.items.filter((item) => !item.pinned && item.createdAt < cutoff).length;
  }

  prune({ retentionDays, now = Date.now(), maxItems = MAX_ITEMS }) {
    const cutoff = now - retentionDays * DAY_MS;
    const removed = [];

    this.store.state.items = this.items.filter((item) => {
      if (!item.pinned && item.createdAt < cutoff) {
        removed.push(item);
        return false;
      }
      return true;
    });

    let trimmed = 0;
    while (this.items.length > maxItems) {
      let oldestIndex = -1;
      let oldestTime = Infinity;
      for (let i = 0; i < this.items.length; i += 1) {
        const item = this.items[i];
        if (!item.pinned && item.createdAt < oldestTime) {
          oldestTime = item.createdAt;
          oldestIndex = i;
        }
      }
      if (oldestIndex === -1) break;
      const [item] = this.items.splice(oldestIndex, 1);
      removed.push(item);
      trimmed += 1;
    }

    if (removed.length > 0) {
      for (const item of removed) this.deleteFilesFor(item);
      this.store.markDirty();
    }
    return { removed: removed.length - trimmed, trimmed, totalRemoved: removed.length };
  }

  trimToMax(maxItems = MAX_ITEMS) {
    let removed = 0;
    while (this.items.length > maxItems) {
      let oldestIndex = -1;
      let oldestTime = Infinity;
      for (let i = 0; i < this.items.length; i += 1) {
        const item = this.items[i];
        if (!item.pinned && item.createdAt < oldestTime) {
          oldestTime = item.createdAt;
          oldestIndex = i;
        }
      }
      if (oldestIndex === -1) break;
      const [item] = this.items.splice(oldestIndex, 1);
      this.deleteFilesFor(item);
      removed += 1;
    }
    return removed;
  }

  query({ search = '', offset = 0, limit = 100 } = {}) {
    const query = typeof search === 'string' ? search.trim().slice(0, 200).toLowerCase() : '';
    const filtered = this.items.filter((item) => {
      if (!query) return true;
      if (item.type !== 'text') return false;
      return item.text.toLowerCase().includes(query);
    });

    const pinned = filtered.filter((item) => item.pinned).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
    const normal = filtered.filter((item) => !item.pinned).sort((a, b) => b.createdAt - a.createdAt);
    const sorted = pinned.concat(normal);

    const start = Math.max(0, Number.isInteger(offset) ? offset : 0);
    const end = start + Math.max(1, Math.min(Number.isInteger(limit) ? limit : 100, 200));
    return {
      total: sorted.length,
      items: sorted.slice(start, end).map((item) => this.toDTO(item)),
    };
  }

  toDTO(item) {
    if (item.type === 'text') {
      return {
        id: item.id,
        type: 'text',
        createdAt: item.createdAt,
        pinned: item.pinned,
        pinnedAt: item.pinnedAt,
        previewText: item.text.slice(0, PREVIEW_CHARS),
        chars: item.text.length,
      };
    }
    return {
      id: item.id,
      type: 'image',
      createdAt: item.createdAt,
      pinned: item.pinned,
      pinnedAt: item.pinnedAt,
      image: {
        file: item.image.file,
        thumb: item.image.thumb,
        width: item.image.width,
        height: item.image.height,
        size: item.image.size,
      },
    };
  }

  deleteFilesFor(item) {
    if (!item || item.type !== 'image' || !item.image) return;
    const stillReferenced = this.items.some(
      (other) => other && other.type === 'image' && other.image && other.image.file === item.image.file
    );
    if (stillReferenced) return;

    for (const filePath of [path.join(this.imagesDir, item.image.file), path.join(this.thumbsDir, item.image.thumb)]) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // 忽略删除失败（孤儿文件会在下次清理时处理）
      }
    }
  }

  cleanupOrphanFiles() {
    const referenced = new Set();
    for (const item of this.items) {
      if (item.type === 'image' && item.image) {
        referenced.add(`images/${item.image.file}`);
        referenced.add(`thumbs/${item.image.thumb}`);
      }
    }

    let removed = 0;
    for (const [dir, prefix] of [
      [this.imagesDir, 'images'],
      [this.thumbsDir, 'thumbs'],
    ]) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!referenced.has(`${prefix}/${name}`)) {
          try {
            fs.rmSync(path.join(dir, name), { force: true });
            removed += 1;
          } catch {
            // 忽略
          }
        }
      }
    }
    return removed;
  }

  stats() {
    let texts = 0;
    let images = 0;
    let pinned = 0;
    for (const item of this.items) {
      if (item.type === 'text') texts += 1;
      else images += 1;
      if (item.pinned) pinned += 1;
    }
    return { total: this.items.length, texts, images, pinned };
  }
}

module.exports = { ItemService, MAX_TEXT_CHARS, MAX_ITEMS, PREVIEW_CHARS, DAY_MS, sha256, isHexHash };
