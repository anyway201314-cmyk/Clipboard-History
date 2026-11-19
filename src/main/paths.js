'use strict';

// 数据目录的唯一来源：打包版在 exe 同目录 data/，开发版在项目根 data-dev/。
// initPaths() 必须在 app ready 之前调用，确保 Chromium 的 userData/sessionData
// 也落在便携目录，避免 AppData 残留。

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

function getRootDir() {
  return app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
}

function getDataDir() {
  return path.join(getRootDir(), app.isPackaged ? 'data' : 'data-dev');
}

function ensureWritable(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.write-test-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe, { force: true });
}

function initPaths() {
  const dataDir = getDataDir();
  const dirs = {
    dataDir,
    imagesDir: path.join(dataDir, 'images'),
    thumbsDir: path.join(dataDir, 'thumbs'),
    logsDir: path.join(dataDir, 'logs'),
    userDataDir: path.join(dataDir, 'userData'),
    sessionDir: path.join(dataDir, 'session'),
  };

  ensureWritable(dataDir);
  for (const dir of [dirs.imagesDir, dirs.thumbsDir, dirs.logsDir, dirs.userDataDir, dirs.sessionDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  app.setPath('userData', dirs.userDataDir);
  app.setPath('sessionData', dirs.sessionDir);
  return dirs;
}

module.exports = { initPaths, getDataDir, getRootDir };
