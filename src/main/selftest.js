'use strict';

// 自动化自检（阶段 1）：验证异步剪贴板采集、去重、自写抑制、文件跳过、超限跳过。
// 用法：electron . --selftest [--cpu-test=秒数]
// 结果写入 <dataDir>/selftest-result.json，并尝试打印到终端。
// 注意：自检会临时改写系统剪贴板，结束时尽力恢复原内容。

const fs = require('node:fs');
const path = require('node:path');
const { clipboard, ClipboardItem, nativeImage } = require('electron');

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeTestPng(width, height) {
  const buffer = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      buffer[i] = (x * 7) & 0xff;
      buffer[i + 1] = (y * 5) & 0xff;
      buffer[i + 2] = ((x + y) * 3) & 0xff;
      buffer[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buffer, { width, height }).toPNG();
}

async function snapshotClipboard() {
  const snapshot = { text: '', imagePng: null };
  try {
    snapshot.text = await clipboard.readText();
  } catch {
    // 忽略
  }
  try {
    const items = await clipboard.read();
    const imageItem = items.find((item) => item.types.some((type) => type.startsWith('image/')));
    if (imageItem) {
      const mime = imageItem.types.find((type) => type.startsWith('image/'));
      const blob = await imageItem.getType(mime);
      const raw = Buffer.from(await blob.arrayBuffer());
      if (mime === 'image/png') {
        snapshot.imagePng = raw;
      } else {
        const image = nativeImage.createFromBuffer(raw);
        if (!image.isEmpty()) snapshot.imagePng = image.toPNG();
      }
    }
  } catch {
    // 忽略
  }
  return snapshot;
}

async function restoreClipboard(snapshot) {
  try {
    if (snapshot.imagePng) {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([snapshot.imagePng]) })]);
    } else if (snapshot.text) {
      await clipboard.writeText(snapshot.text);
    }
  } catch {
    // 尽力而为
  }
}

async function runCpuTest({ watcher, logger, durationSec }) {
  const result = { durationSec, samples: [], avgPercent: 0, maxPercent: 0, imagesDuringTest: 0 };
  const png = makeTestPng(3840, 2160);
  const imagesBefore = watcher.stats.images;
  try {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png]) })]);
  } catch (err) {
    result.error = `写入 4K 测试图片失败: ${err && err.message ? err.message : err}`;
    return result;
  }

  await sleep(2500); // 等待首次采集
  process.getCPUUsage(); // 重置统计窗口
  const start = Date.now();
  while (Date.now() - start < durationSec * 1000) {
    await sleep(5000);
    const usage = process.getCPUUsage();
    result.samples.push(Math.round(usage.percentCPUUsage * 100) / 100);
  }

  result.imagesDuringTest = watcher.stats.images - imagesBefore;
  const samples = result.samples.slice(1);
  if (samples.length > 0) {
    result.avgPercent = Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 100) / 100;
    result.maxPercent = Math.max(...samples);
  }
  logger.info('selftest', `cpu test avg=${result.avgPercent} max=${result.maxPercent} images=${result.imagesDuringTest}`);
  return result;
}

async function runSelfTest({ watcher, logger, dataDir, cpuSeconds = 0 }) {
  const results = [];
  const events = [];
  const oversized = [];

  watcher.on('capture', (capture) => events.push({ ...capture, at: Date.now() }));
  watcher.on('oversized', (info) => oversized.push(info));

  const snapshot = await snapshotClipboard();
  const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });
  const waitFor = async (predicate, timeoutMs) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true;
      await sleep(100);
    }
    return false;
  };

  let cpuResult = null;

  try {
    await clipboard.clear();
    watcher.start();
    await sleep(1000);
    check('启动基线：不记录启动时剪贴板内容', events.length === 0 && watcher.baselineDone, `events=${events.length}`);

    const markerA = `selftest-text-${Date.now()}`;
    await clipboard.writeText(markerA);
    const gotText = await waitFor(() => events.some((e) => e.type === 'text' && e.text === markerA), 2500);
    check('文本采集（≤2.5s）', gotText);

    const textCount = () => events.filter((e) => e.type === 'text' && e.text === markerA).length;
    await sleep(1800);
    check('内容不变时不重复触发', textCount() === 1, `count=${textCount()}`);

    const beforeSelf = events.length;
    await watcher.copyText(markerA);
    await sleep(1800);
    check('自写抑制：复制卡片不产生新记录', events.length === beforeSelf, `before=${beforeSelf} after=${events.length}`);

    const markerB = `selftest-other-${Date.now()}`;
    await clipboard.writeText(markerB);
    await waitFor(() => events.some((e) => e.type === 'text' && e.text === markerB), 2500);
    await clipboard.writeText(markerA);
    const reCaptured = await waitFor(() => textCount() >= 2, 2500);
    check('A→B→A 会重新触发（供数据层合并）', reCaptured);

    await clipboard.clear();
    await sleep(800);
    const png = makeTestPng(320, 200);
    const imagesBefore = events.filter((e) => e.type === 'image').length;
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png]) })]);
    const gotImage = await waitFor(() => events.filter((e) => e.type === 'image').length > imagesBefore, 3500);
    check('图片采集（≤3.5s）', gotImage);

    await sleep(2600);
    const imageDelta = events.filter((e) => e.type === 'image').length - imagesBefore;
    check('图片内容不变时不重复触发（哈希稳定）', imageDelta === 1, `count=${imageDelta}`);

    const imageEvent = [...events].reverse().find((e) => e.type === 'image');
    if (imageEvent) {
      const countBefore = events.filter((e) => e.type === 'image').length;
      await watcher.copyImage(imageEvent.buffer);
      await sleep(2200);
      check('自写抑制：复制图片卡片不产生新记录', events.filter((e) => e.type === 'image').length === countBefore);
    } else {
      check('自写抑制：复制图片卡片不产生新记录', false, '未获取到图片事件');
    }

    const skippedBefore = watcher.stats.skippedFiles;
    let uriWritten = true;
    try {
      await clipboard.write([new ClipboardItem({ 'text/uri-list': 'file:///C:/selftest-file.txt' })]);
    } catch {
      uriWritten = false;
    }
    if (uriWritten) {
      await waitFor(() => watcher.stats.skippedFiles > skippedBefore, 3000);
      const skipDetected = watcher.stats.skippedFiles > skippedBefore;
      const eventsBefore = events.length;
      await sleep(1600);
      check(
        '复制文件（text/uri-list）被跳过',
        skipDetected && events.length === eventsBefore,
        `skipped=${watcher.stats.skippedFiles - skippedBefore}`
      );
    } else {
      check('复制文件（text/uri-list）被跳过', false, '写入 uri-list 失败，需要人工验证');
    }

    await clipboard.clear();
    await sleep(800);
    const oversizedBefore = oversized.length;
    await clipboard.writeText('x'.repeat(200001));
    await waitFor(() => oversized.length > oversizedBefore, 3000);
    check('超过 20 万字符被跳过', oversized.length > oversizedBefore, `oversized=${oversized.length - oversizedBefore}`);

    if (cpuSeconds > 0) {
      cpuResult = await runCpuTest({ watcher, logger, durationSec: cpuSeconds });
      check(
        '4K 图片 CPU 测试完成',
        !cpuResult.error,
        cpuResult.error || `avg=${cpuResult.avgPercent}% max=${cpuResult.maxPercent}% images=${cpuResult.imagesDuringTest}`
      );
    }
  } catch (err) {
    logger.error('selftest', err && err.stack ? err.stack : String(err));
    check('自检执行异常', false, err && err.message ? err.message : String(err));
  } finally {
    watcher.stop();
    await restoreClipboard(snapshot);
  }

  const failed = results.filter((result) => !result.ok);
  const summary = {
    date: new Date().toISOString(),
    passed: results.length - failed.length,
    total: results.length,
    failed: failed.length,
    stats: { ...watcher.stats },
    cpu: cpuResult,
    results,
  };

  try {
    fs.writeFileSync(path.join(dataDir, 'selftest-result.json'), JSON.stringify(summary, null, 2), 'utf8');
  } catch (err) {
    logger.error('selftest', `write result failed: ${err && err.message ? err.message : err}`);
  }
  try {
    console.log(JSON.stringify(summary, null, 2));
  } catch {
    // Windows GUI 进程可能没有控制台
  }
  logger.info('selftest', `done passed=${summary.passed}/${summary.total} failed=${summary.failed}`);
  return failed.length === 0 ? 0 : 1;
}

module.exports = { runSelfTest };
