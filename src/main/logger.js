'use strict';

// 简单滚动日志：只记录事件与技术信息，绝不写入剪贴板正文。
// 同一类消息限频，避免剪贴板被占用时刷屏。

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 1024 * 1024;
const THROTTLE_WINDOW_MS = 60 * 1000;
const THROTTLE_MAX = 3;

function createLogger(logsDir) {
  const file = path.join(logsDir, 'app.log');
  const throttleMap = new Map();

  function rotateIfNeeded() {
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_LOG_BYTES) {
        const oldFile = `${file}.old`;
        fs.rmSync(oldFile, { force: true });
        fs.renameSync(file, oldFile);
      }
    } catch {
      // 文件不存在或暂时不可读：忽略
    }
  }

  function write(level, moduleName, message) {
    const line = `${new Date().toISOString()} [${level}] [${moduleName}] ${message}\n`;
    try {
      rotateIfNeeded();
      fs.appendFileSync(file, line, 'utf8');
    } catch {
      // 日志失败不能影响主流程
    }
  }

  function throttled(moduleName, message) {
    const key = `${moduleName}|${message}`;
    const now = Date.now();
    const record = throttleMap.get(key);
    if (record && now - record.start < THROTTLE_WINDOW_MS) {
      record.count += 1;
      if (record.count > THROTTLE_MAX) return;
    } else {
      throttleMap.set(key, { start: now, count: 1 });
    }
    write('WARN', moduleName, message);
  }

  return {
    info: (moduleName, message) => write('INFO', moduleName, message),
    warn: throttled,
    error: (moduleName, message) => write('ERROR', moduleName, message),
  };
}

module.exports = { createLogger };
