'use strict';

// 索引持久化：index.json + index.json.bak
// - 原子写：tmp + fsync + rename
// - 每次写入前把旧主文件复制为 .bak
// - 启动时主文件损坏则从 .bak 恢复；两者都坏则隔离并以空数据启动（绝不静默清空）
// - 本模块为纯 Node 实现，不依赖 Electron，便于 node:test 测试

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const CURRENT_SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 400;
const MAX_TEXT_CHARS = 200000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Store {
  constructor({ dataDir, logger, onSaveError }) {
    this.dataDir = dataDir;
    this.indexFile = path.join(dataDir, 'index.json');
    this.backupFile = path.join(dataDir, 'index.json.bak');
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.onSaveError = typeof onSaveError === 'function' ? onSaveError : null;
    this.state = { schemaVersion: CURRENT_SCHEMA_VERSION, items: [] };
    this.dirty = false;
    this.timer = null;
    this.writing = Promise.resolve();
    this.warnings = [];
  }

  async load() {
    let parsed = null;
    let fromBackup = false;

    try {
      parsed = await this.readAndParse(this.indexFile);
    } catch (err) {
      const mainMissing = err.code === 'ENOENT';
      const backupExists = fs.existsSync(this.backupFile);

      if (mainMissing && !backupExists) {
        this.state = { schemaVersion: CURRENT_SCHEMA_VERSION, items: [] };
        return { warnings: [] };
      }

      try {
        parsed = await this.readAndParse(this.backupFile);
        fromBackup = true;
        await this.quarantine(this.indexFile, 'corrupt');
        this.warnings.push('主数据文件缺失或损坏，已从备份恢复。');
        this.logger.warn('store', 'index missing or corrupted, recovered from backup');
      } catch {
        await this.quarantine(this.indexFile, 'corrupt');
        if (backupExists) await this.quarantine(this.backupFile, 'corrupt');
        this.state = { schemaVersion: CURRENT_SCHEMA_VERSION, items: [] };
        this.warnings.push('数据文件与备份均无法读取，已隔离损坏文件并以空数据启动。');
        this.logger.error('store', 'index and backup corrupted; quarantined');
        return { warnings: this.warnings };
      }
    }

    if (parsed.schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw Object.assign(new Error(`数据版本 ${parsed.schemaVersion} 高于当前程序支持版本，已停止写入以防损坏`), {
        code: 'FUTURE_SCHEMA',
      });
    }
    if (parsed.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw Object.assign(new Error('未知的数据版本'), { code: 'UNKNOWN_SCHEMA' });
    }

    const { items, invalidCount } = this.validateItems(parsed.items);
    if (invalidCount > 0) {
      try {
        const archive = path.join(this.dataDir, `index.invalid-${Date.now()}.json`);
        await fsp.writeFile(
          archive,
          JSON.stringify({ schemaVersion: parsed.schemaVersion, items: parsed.items }, null, 2),
          'utf8'
        );
      } catch {
        // 留档失败不影响启动
      }
      this.warnings.push(`发现 ${invalidCount} 条无法识别的记录，已跳过并留档。`);
      this.logger.warn('store', `invalid items skipped count=${invalidCount}`);
    }

    this.state = { schemaVersion: CURRENT_SCHEMA_VERSION, items };
    if (fromBackup || invalidCount > 0) this.dirty = true;
    return { warnings: this.warnings };
  }

  async readAndParse(file) {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('索引格式无效');
    if (typeof parsed.schemaVersion !== 'number') throw new Error('缺少 schemaVersion');
    if (!Array.isArray(parsed.items)) throw new Error('items 不是数组');
    return parsed;
  }

  validateItems(rawItems) {
    const items = [];
    let invalidCount = 0;
    for (const raw of rawItems) {
      if (this.isValidItem(raw)) {
        items.push(raw);
      } else {
        invalidCount += 1;
      }
    }
    return { items, invalidCount };
  }

  isValidItem(item) {
    if (!item || typeof item !== 'object') return false;
    if (typeof item.id !== 'string' || item.id.length === 0 || item.id.length > 100) return false;
    if (item.type !== 'text' && item.type !== 'image') return false;
    if (!Number.isFinite(item.createdAt)) return false;
    if (typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)) return false;
    if (typeof item.pinned !== 'boolean') return false;
    if (item.pinned) {
      if (!Number.isFinite(item.pinnedAt)) return false;
    } else if (item.pinnedAt !== null) {
      return false;
    }

    if (item.type === 'text') {
      if (typeof item.text !== 'string' || item.text.length === 0 || item.text.length > MAX_TEXT_CHARS) return false;
    } else {
      const image = item.image;
      if (!image || typeof image !== 'object') return false;
      if (typeof image.file !== 'string' || !/^[a-f0-9]{64}\.png$/.test(image.file)) return false;
      if (typeof image.thumb !== 'string' || !/^[a-f0-9]{64}\.png$/.test(image.thumb)) return false;
      if (!Number.isFinite(image.width) || image.width <= 0) return false;
      if (!Number.isFinite(image.height) || image.height <= 0) return false;
      if (!Number.isFinite(image.size) || image.size < 0) return false;
    }
    return true;
  }

  async quarantine(file, kind) {
    try {
      const target = path.join(path.dirname(file), `${path.basename(file, '.json')}.${kind}-${Date.now()}.json`);
      await fsp.rename(file, target);
    } catch {
      // 文件不存在或无法移动：忽略
    }
  }

  markDirty() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((err) => {
        this.logger.error('store', `deferred save failed: ${err && err.message ? err.message : err}`);
        if (this.onSaveError) this.onSaveError(err);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  async flush(options = {}) {
    const syncBackup = options.syncBackup === true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty && !syncBackup) return;

    const payload = JSON.stringify(this.state);
    const run = async () => {
      let attempt = 0;
      for (;;) {
        try {
          await this.writeAtomic(payload, syncBackup);
          return;
        } catch (err) {
          attempt += 1;
          if (attempt >= 3) throw err;
          await sleep(attempt * 100);
        }
      }
    };

    const task = this.writing.then(run);
    this.writing = task.catch(() => {});
    try {
      await task;
      this.dirty = false;
    } catch (err) {
      this.dirty = true;
      this.logger.error('store', `save failed: ${err && err.message ? err.message : err}`);
      throw err;
    }
  }

  async writeAtomic(payload, syncBackup) {
    const tmp = `${this.indexFile}.tmp`;
    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (!syncBackup) {
      try {
        await fsp.copyFile(this.indexFile, this.backupFile);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }

    await fsp.rename(tmp, this.indexFile);

    if (syncBackup) {
      await fsp.copyFile(this.indexFile, this.backupFile);
    }
  }
}

module.exports = { Store, CURRENT_SCHEMA_VERSION, SAVE_DEBOUNCE_MS, MAX_TEXT_CHARS };
