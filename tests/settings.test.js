'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore, DEFAULT_SETTINGS } = require('../src/main/settings');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-settings-test-'));
}

test('settings: 首次加载使用默认值', () => {
  const dir = makeTempDir();
  try {
    const store = new SettingsStore({ dataDir: dir });
    const result = store.load();
    assert.deepEqual(result.warnings, []);
    assert.equal(store.get().retentionDays, DEFAULT_SETTINGS.retentionDays);
    assert.equal(store.get().launchAtLogin, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings: 更新后持久化并可重新读取', () => {
  const dir = makeTempDir();
  try {
    const store = new SettingsStore({ dataDir: dir });
    store.load();
    const updated = store.update({ retentionDays: 3, launchAtLogin: true });
    assert.equal(updated.ok, true);

    const reopened = new SettingsStore({ dataDir: dir });
    reopened.load();
    assert.equal(reopened.get().retentionDays, 3);
    assert.equal(reopened.get().launchAtLogin, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings: 非法保存天数被拒绝', () => {
  const dir = makeTempDir();
  try {
    const store = new SettingsStore({ dataDir: dir });
    store.load();
    for (const value of [0, 31, -1, 1.5, 'abc', null]) {
      const result = store.update({ retentionDays: value });
      assert.equal(result.ok, false, `value=${value}`);
    }
    assert.equal(store.get().retentionDays, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings: 损坏的设置文件被隔离并使用默认值', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), 'not json', 'utf8');
    const store = new SettingsStore({ dataDir: dir });
    const result = store.load();
    assert.ok(result.warnings.length >= 1);
    assert.equal(store.get().retentionDays, 7);
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('settings.corrupt-')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings: 高版本设置文件不被覆盖', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ schemaVersion: 2, retentionDays: 3 }), 'utf8');
    const store = new SettingsStore({ dataDir: dir });
    const result = store.load();
    assert.ok(result.warnings.length >= 1);
    assert.equal(store.get().retentionDays, 7);
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('settings.corrupt-')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
