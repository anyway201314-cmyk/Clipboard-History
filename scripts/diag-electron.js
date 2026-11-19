'use strict';

// 临时诊断脚本：输出 Electron 45 的模块导出与 app.setPath 行为。
// 用法：electron scripts/diag-electron.js

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data-dev', 'diag-result.txt');
const lines = [];

function log(text) {
  lines.push(text);
}

function flush() {
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  } catch {
    // 忽略
  }
}

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT: ${err && err.stack ? err.stack : err}`);
  flush();
  process.exit(1);
});

const electron = require('electron');
log(`electron keys: ${Object.keys(electron).join(',')}`);
for (const name of ['app', 'dialog', 'clipboard', 'nativeImage', 'screen', 'session', 'BrowserWindow', 'Tray']) {
  log(`typeof ${name} = ${typeof electron[name]}`);
}

try {
  log(`isPackaged = ${electron.app.isPackaged}`);
} catch (err) {
  log(`isPackaged ERR: ${err.message}`);
}
try {
  log(`getAppPath = ${electron.app.getAppPath()}`);
} catch (err) {
  log(`getAppPath ERR: ${err.message}`);
}

const testDir = path.join(ROOT, 'data-dev', 'diag-test');
try {
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(testDir, 'probe.txt'), 'ok');
  log('mkdir/write probe ok');
} catch (err) {
  log(`mkdir/write probe ERR: ${err.message}`);
}
try {
  electron.app.setPath('userData', path.join(testDir, 'userData'));
  log('setPath userData ok');
} catch (err) {
  log(`setPath userData ERR: ${err.message}`);
}
try {
  electron.app.setPath('sessionData', path.join(testDir, 'session'));
  log('setPath sessionData ok');
} catch (err) {
  log(`setPath sessionData ERR: ${err.message}`);
}

electron.app.whenReady().then(() => {
  log(`after ready: typeof dialog = ${typeof electron.dialog}`);
  log(`after ready: typeof clipboard = ${typeof electron.clipboard}`);
  flush();
  electron.app.exit(0);
});
