'use strict';

// 组装绿色交付文件夹：
//   dist/win-unpacked + 使用说明.txt（带 BOM）+ 应用图标 + 快捷方式 + SHA256.txt
// 并做安全检查：不得包含 data、源码、docs、开发日志。
// 用法：node scripts/assemble-release.js

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const PRODUCT_NAME = pkg.productName || pkg.name;
const SOURCE_DIR = path.join(ROOT, 'dist', 'win-unpacked');
const RELEASE_ROOT = path.join(ROOT, '交付');
const TARGET_DIR = path.join(RELEASE_ROOT, `${PRODUCT_NAME}-v${VERSION}`);
const EXE_NAME = `${PRODUCT_NAME}.exe`;
const EXE_PATH = path.join(TARGET_DIR, EXE_NAME);
const ICON_SOURCE = path.join(ROOT, 'build', 'icon.ico');
const ICON_TARGET = path.join(TARGET_DIR, `${PRODUCT_NAME}.ico`);
const GUIDE_SOURCE = path.join(ROOT, 'docs', '使用说明.txt');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fail(message) {
  console.error(`组装失败：${message}`);
  process.exit(1);
}

if (!fs.existsSync(SOURCE_DIR)) fail(`找不到构建产物：${SOURCE_DIR}（请先运行 npm run dist）`);
if (!fs.existsSync(EXE_PATH.replace(TARGET_DIR, SOURCE_DIR))) fail('构建产物中缺少主程序 exe');
if (!fs.existsSync(ICON_SOURCE)) fail('缺少 build/icon.ico，请先运行 npm run icons');
if (!fs.existsSync(GUIDE_SOURCE)) fail('缺少 docs/使用说明.txt');

fs.mkdirSync(RELEASE_ROOT, { recursive: true });
fs.rmSync(TARGET_DIR, { recursive: true, force: true });
fs.mkdirSync(TARGET_DIR, { recursive: true });

// 1. 复制程序文件
fs.cpSync(SOURCE_DIR, TARGET_DIR, { recursive: true });

// 2. 移除测试遗留数据（绝不能带进交付物）
for (const name of ['data', 'data-dev']) {
  fs.rmSync(path.join(TARGET_DIR, name), { recursive: true, force: true });
}

// 3. 应用图标（供快捷方式使用）
fs.copyFileSync(ICON_SOURCE, ICON_TARGET);

// 4. 使用说明（带 BOM，CRLF，方便记事本直接打开）
const guide = fs.readFileSync(GUIDE_SOURCE, 'utf8').replace(/\r?\n/g, '\r\n');
fs.writeFileSync(path.join(TARGET_DIR, '使用说明.txt'), `﻿${guide}`, 'utf8');

// 5. 快捷方式（带应用图标）
const shortcutPath = path.join(TARGET_DIR, `${PRODUCT_NAME}.lnk`);
const psScript = [
  '$ws = New-Object -ComObject WScript.Shell',
  `$lnk = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')`,
  `$lnk.TargetPath = '${EXE_PATH.replace(/'/g, "''")}'`,
  `$lnk.WorkingDirectory = '${TARGET_DIR.replace(/'/g, "''")}'`,
  `$lnk.IconLocation = '${ICON_TARGET.replace(/'/g, "''")}'`,
  "$lnk.Description = '历史剪贴板（本地剪贴板历史）'",
  '$lnk.Save()',
].join('\r\n');
const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
const shortcutResult = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
  encoding: 'utf8',
});
if (shortcutResult.status !== 0) {
  console.warn('警告：快捷方式创建失败，可手动创建。');
  console.warn(shortcutResult.stderr || shortcutResult.stdout || '');
}

// 6. 安全检查：禁止包含源码/文档/日志/数据
for (const name of ['data', 'data-dev', 'src', 'docs', '开发日志', 'node_modules', 'dist']) {
  if (fs.existsSync(path.join(TARGET_DIR, name))) {
    fail(`交付目录中不应包含 ${name}`);
  }
}
if (!fs.existsSync(EXE_PATH)) fail('交付目录中缺少主程序 exe');

// 7. 验证 exe 哈希与官方 electron.exe 一致（智能应用控制兼容）
const officialElectron = require('electron'); // 普通 Node 下返回官方 electron.exe 路径
const officialHash = sha256(fs.readFileSync(officialElectron));
const exeBuffer = fs.readFileSync(EXE_PATH);
const exeHash = sha256(exeBuffer);
if (exeHash !== officialHash) {
  fail('主程序哈希与官方 electron.exe 不一致，可能被智能应用控制拦截');
}

// 8. 生成 SHA256
const guideBuffer = fs.readFileSync(path.join(TARGET_DIR, '使用说明.txt'));
const iconBuffer = fs.readFileSync(ICON_TARGET);
const hashLines = [
  `SHA256 (${EXE_NAME}) = ${exeHash}`,
  'SHA256 (使用说明.txt) = ' + sha256(guideBuffer),
  `SHA256 (${PRODUCT_NAME}.ico) = ${sha256(iconBuffer)}`,
  '',
];
fs.writeFileSync(path.join(TARGET_DIR, 'SHA256.txt'), hashLines.join('\r\n'), 'utf8');

console.log(`交付目录已生成：${path.relative(ROOT, TARGET_DIR)}`);
console.log(`  主程序哈希与官方 electron.exe 一致：${exeHash.slice(0, 16)}…`);
console.log('  包含：程序文件、使用说明.txt、应用图标、快捷方式、SHA256.txt');
