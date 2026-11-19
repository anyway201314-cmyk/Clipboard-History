'use strict';

// 构建后处理：用官方 electron.exe 覆盖打包产物中的主程序 exe。
//
// 原因：Windows 11「智能应用控制」（Smart App Control）会把被修改过的
// 未签名 exe 视为未知程序并拦截。electron-builder 会向 exe 写入图标/版本/
// asar 完整性资源，导致文件哈希变化。官方 electron.exe 的哈希在系统中已有
// 信誉，可正常运行；因此保留其原始字节，仅使用产品文件名。
//
// 用法：node scripts/restore-exe.js（由 npm run dist 自动调用）

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist', 'win-unpacked');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const productName = pkg.productName || pkg.name;
const target = path.join(OUT_DIR, `${productName}.exe`);
const source = require('electron'); // 普通 Node 环境下返回官方 electron.exe 的路径

if (typeof source !== 'string' || !fs.existsSync(source)) {
  console.error('找不到官方 electron.exe，无法恢复可执行文件');
  process.exit(1);
}
if (!fs.existsSync(target)) {
  console.error(`找不到打包产物：${target}`);
  process.exit(1);
}

const sourceBuffer = fs.readFileSync(source);
const targetBuffer = fs.readFileSync(target);

if (sourceBuffer.equals(targetBuffer)) {
  console.log('exe 已与官方一致，无需替换');
  process.exit(0);
}

fs.copyFileSync(source, target);
console.log(
  `已用官方 electron.exe 覆盖 ${path.relative(ROOT, target)}` +
    '（保持文件哈希与官方一致，避免智能应用控制拦截）'
);
