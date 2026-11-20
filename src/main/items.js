'use strict';

// 条目业务逻辑：入库、去重、置顶、删除、清空、过期清理、容量上限、搜索、分页 DTO。
// 去重规则：
//  - 文字：忽略换行符差异（CRLF/CR）与首尾空白，按可见内容判重；
//  - 图片：按像素内容（pixelHash）判重，而不是 PNG 文件字节。
// 重复内容再次复制时：更新原卡片时间并移到最前；置顶内容移到置顶区最前。
// 纯 Node 实现（像素哈希在 main 的 image-files.js 中计算），便于 node:test。

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

function normalizeText(text) {
  return text.normalize('NFC').replace(/\r\n?/g, '\n').trim();
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

  findTextMatches(normalizedText) {
    return this.items.filter((item) => item.type === 'text' && normalizeText(item.text) === normalizedText);
  }

  findImageMatches(pixelHash) {
    return this.items.filter((item) => item.type === 'image' && item.image && item.image.pixelHash === pixelHash);
  }

  removeFromItems(item) {
    const index = this.items.indexOf(item);
    if (index !== -1) this.items.splice(index, 1);
  }

  ingestText(text, now = Date.now()) {
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { ok: false, reason: 'empty' };
    }
    if (text.length > MAX_TEXT_CHARS) {
      return { ok: false, reason: 'oversized' };
    }

    const hash = sha256(Buffer.from(text, 'utf8'));
    const normalized = normalizeText(text);
    const matches = this.findTextMatches(normalized);

    if (matches.length > 0) {
      const canonical = matches.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
      const pinnedMatches = matches.filter((item) => item.pinned);

      canonical.text = text;
      canonical.hash = hash;
      canonical.createdAt = now;
      canonical.pinned = pinnedMatches.length > 0;
      canonical.pinnedAt = canonical.pinned ? now : null;

      for (const item of matches) {
        if (item !== canonical) this.removeFromItems(item);
      }

      this.store.markDirty();
      return { ok: true, updated: true, item: canonical, merged: matches.length - 1 };
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

  ingestImage({ buffer, hash, pixelHash, thumbBuffer, width, height, now = Date.now() }) {
    if (!Buffer.isBuffer(buffer) || !Buffer.isBuffer(thumbBuffer)) {
      return { ok: false, reason: 'bad-input' };
    }
    if (!isHexHash(hash) || !isHexHash(pixelHash)) {
      return { ok: false, reason: 'bad-hash' };
    }

    const matches = this.findImageMatches(pixelHash);

    if (matches.length > 0) {
      const canonical = matches.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
      const pinnedMatches = matches.filter((item) => item.pinned);

      // 原图/缩略图缺失时补写（仍复用原条目与文件名）
      const imagePath = path.join(this.imagesDir, canonical.image.file);
      const thumbPath = path.join(this.thumbsDir, canonical.image.thumb);
      if (!fs.existsSync(imagePath)) this.writeFileAtomic(imagePath, buffer);
      if (!fs.existsSync(thumbPath)) this.writeFileAtomic(thumbPath, thumbBuffer);

      canonical.image.pixelHash = pixelHash;
      canonical.createdAt = now;
      canonical.pinned = pinnedMatches.length > 0;
      canonical.pinnedAt = canonical.pinned ? now : null;

      for (const item of matches) {
        if (item !== canonical) {
          this.removeFromItems(item);
          this.deleteFilesFor(item);
        }
      }

      this.store.markDirty();
      return { ok: true, updated: true, item: canonical, merged: matches.length - 1 };
    }

    const file = `${hash}.png`;
    const thumb = `${hash}.png`;
    const imagePath = path.join(this.imagesDir, file);
    const thumbPath = path.join(this.thumbsDir, thumb);

    if (!this.writeFileAtomic(imagePath, buffer)) {
      return { ok: false, reason: 'io' };
    }
    if (!this.writeFileAtomic(thumbPath, thumbBuffer)) {
      try {
        fs.rmSync(imagePath, { force: true });
      } catch {
        // 忽略
      }
      return { ok: false, reason: 'io' };
    }

    const item = {
      id: crypto.randomUUID(),
      type: 'image',
      createdAt: now,
      hash,
      image: { file, thumb, width, height, size: buffer.length, pixelHash },
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

  // 复制（包括点击卡片）后调用：更新时间并移到最前；置顶内容移到置顶区最前
  touch(id, now = Date.now()) {
    const item = this.findById(id);
    if (!item) return { ok: false, error: '条目不存在' };
    item.createdAt = now;
    if (item.pinned) item.pinnedAt = now;
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

  // 启动时合并历史遗留的重复条目（文字按归一化内容，图片按 pixelHash）
  dedupeItems() {
    let mergedText = 0;
    let mergedImage = 0;

    const textGroups = new Map();
    for (const item of [...this.items]) {
      if (item.type !== 'text') continue;
      const key = normalizeText(item.text);
      if (!textGroups.has(key)) textGroups.set(key, []);
      textGroups.get(key).push(item);
    }
    for (const group of textGroups.values()) {
      if (group.length < 2) continue;
      const canonical = group.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
      const pinnedMatches = group.filter((item) => item.pinned);
      if (pinnedMatches.length > 0) {
        canonical.pinned = true;
        canonical.pinnedAt = Math.max(...pinnedMatches.map((item) => item.pinnedAt || 0));
      }
      for (const item of group) {
        if (item !== canonical) {
          this.removeFromItems(item);
          mergedText += 1;
        }
      }
    }

    const imageGroups = new Map();
    for (const item of [...this.items]) {
      if (item.type !== 'image' || !item.image || !item.image.pixelHash) continue;
      const key = item.image.pixelHash;
      if (!imageGroups.has(key)) imageGroups.set(key, []);
      imageGroups.get(key).push(item);
    }
    for (const group of imageGroups.values()) {
      if (group.length < 2) continue;
      const canonical = group.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
      const pinnedMatches = group.filter((item) => item.pinned);
      if (pinnedMatches.length > 0) {
        canonical.pinned = true;
        canonical.pinnedAt = Math.max(...pinnedMatches.map((item) => item.pinnedAt || 0));
      }
      for (const item of group) {
        if (item !== canonical) {
          this.removeFromItems(item);
          this.deleteFilesFor(item);
          mergedImage += 1;
        }
      }
    }

    if (mergedText + mergedImage > 0) this.store.markDirty();
    return { mergedText, mergedImage, total: mergedText + mergedImage };
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

module.exports = {
  ItemService,
  MAX_TEXT_CHARS,
  MAX_ITEMS,
  PREVIEW_CHARS,
  DAY_MS,
  sha256,
  isHexHash,
  normalizeText,
};
