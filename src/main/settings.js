'use strict';

// 设置持久化（独立文件，避免索引损坏时设置一起丢失）。纯 Node 实现。

const fs = require('node:fs');
const path = require('node:path');

const SETTINGS_SCHEMA_VERSION = 1;
const DEFAULT_SETTINGS = Object.freeze({ schemaVersion: SETTINGS_SCHEMA_VERSION, retentionDays: 7, launchAtLogin: false });
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 30;

function validateRetentionDays(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= MIN_RETENTION_DAYS && number <= MAX_RETENTION_DAYS;
}

class SettingsStore {
  constructor({ dataDir, logger }) {
    this.file = path.join(dataDir, 'settings.json');
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.settings = { ...DEFAULT_SETTINGS };
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.schemaVersion !== 'number') {
        throw new Error('设置文件格式无效');
      }
      if (parsed.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
        throw new Error(`设置版本 ${parsed.schemaVersion} 不受支持`);
      }

      const warnings = [];
      let retentionDays = DEFAULT_SETTINGS.retentionDays;
      if (validateRetentionDays(parsed.retentionDays)) {
        retentionDays = Number(parsed.retentionDays);
      } else {
        warnings.push('保存天数设置无效，已使用默认 7 天。');
      }
      const launchAtLogin = parsed.launchAtLogin === true;

      this.settings = { schemaVersion: SETTINGS_SCHEMA_VERSION, retentionDays, launchAtLogin };
      return { settings: this.get(), warnings };
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.settings = { ...DEFAULT_SETTINGS };
        return { settings: this.get(), warnings: [] };
      }
      const target = this.file.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
      try {
        fs.renameSync(this.file, target);
      } catch {
        // 忽略
      }
      this.settings = { ...DEFAULT_SETTINGS };
      this.logger.warn('settings', `settings load failed, defaults used: ${err && err.message ? err.message : err}`);
      return { settings: this.get(), warnings: ['设置文件无法读取，已使用默认设置（原文件已留档）。'] };
    }
  }

  get() {
    return { ...this.settings };
  }

  update(patch = {}) {
    const next = { ...this.settings };
    if ('retentionDays' in patch) {
      if (!validateRetentionDays(patch.retentionDays)) {
        return { ok: false, error: '保存天数需为 1–30 的整数' };
      }
      next.retentionDays = Number(patch.retentionDays);
    }
    if ('launchAtLogin' in patch) {
      next.launchAtLogin = Boolean(patch.launchAtLogin);
    }

    this.settings = next;
    try {
      this.save();
      return { ok: true, settings: this.get() };
    } catch (err) {
      return { ok: false, error: '设置保存失败，请检查文件夹权限', detail: err && err.message ? err.message : String(err) };
    }
  }

  save() {
    const payload = JSON.stringify(this.settings, null, 2);
    const tmp = `${this.file}.tmp`;
    const handle = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(handle, payload, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tmp, this.file);
  }
}

module.exports = {
  SettingsStore,
  DEFAULT_SETTINGS,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  validateRetentionDays,
};
