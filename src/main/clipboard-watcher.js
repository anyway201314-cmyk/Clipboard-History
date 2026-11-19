'use strict';

// 剪贴板采集（阶段 1 版本）
// Electron 44+ 的 clipboard 为异步 API：readText()/read()/write() 返回 Promise。
// 策略：文本每 600ms 轮询；图片仅在文本为空且存在图片格式时按 1.5s 节流读取；
// 内容哈希去重；text/uri-list（复制文件）整条跳过；自写抑制与启动基线。

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { clipboard, ClipboardItem, nativeImage } = require('electron');

const POLL_MS = 600;
const IMAGE_READ_MS = 1500;
const MAX_TEXT_CHARS = 200000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SELF_WRITE_SUPPRESS_MS = 1200;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

class ClipboardWatcher extends EventEmitter {
  constructor({ logger }) {
    super();
    this.logger = logger;
    this.timer = null;
    this.busy = false;
    this.stopped = true;
    this.baselineDone = false;
    this.lastText = null;
    this.lastImageHash = null;
    this.lastImageReadAt = 0;
    this.suppressUntil = 0;
    this.inFileCopy = false;
    this.lastTypes = [];
    this.stats = { texts: 0, images: 0, skippedFiles: 0, oversized: 0 };
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.tick();
    }, POLL_MS);
    this.logger.info('watcher', 'started');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
  }

  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const text = await clipboard.readText();
      const items = await clipboard.read();
      const types = items.flatMap((item) => (item && item.types) || []);
      this.lastTypes = types;

      // 复制文件（CF_HDROP → text/uri-list）：整条跳过
      if (types.includes('text/uri-list')) {
        if (!this.inFileCopy) {
          this.inFileCopy = true;
          this.stats.skippedFiles += 1;
          this.logger.info('watcher', 'file copy detected, skipped');
        }
        return;
      }
      this.inFileCopy = false;

      const cleanText = typeof text === 'string' ? text : '';
      let capture = null;

      if (cleanText.trim().length > 0) {
        if (cleanText !== this.lastText) {
          this.lastText = cleanText;
          if (cleanText.length > MAX_TEXT_CHARS) {
            this.stats.oversized += 1;
            this.logger.warn('watcher', `oversized text skipped chars=${cleanText.length}`);
            this.emit('oversized', { type: 'text', chars: cleanText.length });
          } else {
            capture = { type: 'text', text: cleanText };
          }
        }
      } else if (types.some((type) => type.startsWith('image/'))) {
        const now = Date.now();
        if (now - this.lastImageReadAt >= IMAGE_READ_MS) {
          this.lastImageReadAt = now;
          const imageItem = items.find((item) => item.types.some((type) => type.startsWith('image/')));
          const mime = imageItem.types.find((type) => type.startsWith('image/'));
          const blob = await imageItem.getType(mime);
          const raw = Buffer.from(await blob.arrayBuffer());

          if (raw.length > MAX_IMAGE_BYTES) {
            this.stats.oversized += 1;
            this.logger.warn('watcher', `oversized image skipped bytes=${raw.length}`);
            this.emit('oversized', { type: 'image', bytes: raw.length });
          } else {
            let png = raw;
            if (mime !== 'image/png') {
              const converted = nativeImage.createFromBuffer(raw);
              if (!converted.isEmpty()) png = converted.toPNG();
            }
            const hash = sha256(png);
            if (hash !== this.lastImageHash) {
              this.lastImageHash = hash;
              const image = nativeImage.createFromBuffer(png);
              const size = image.getSize();
              capture = {
                type: 'image',
                buffer: png,
                hash,
                width: size.width,
                height: size.height,
                mime,
              };
            }
          }
        }
      }

      // 启动后的第一次成功读取只作为基线，不写入历史
      if (!this.baselineDone) {
        this.baselineDone = true;
        this.logger.info('watcher', 'baseline captured');
        return;
      }

      if (capture && Date.now() >= this.suppressUntil) {
        if (capture.type === 'text') {
          this.stats.texts += 1;
          this.logger.info(
            'watcher',
            `text captured chars=${capture.text.length} hash=${sha256(Buffer.from(capture.text, 'utf8')).slice(0, 8)}`
          );
        } else {
          this.stats.images += 1;
          this.logger.info(
            'watcher',
            `image captured bytes=${capture.buffer.length} hash=${capture.hash.slice(0, 8)} mime=${capture.mime}`
          );
        }
        this.emit('capture', capture);
      }
    } catch (err) {
      this.logger.warn('watcher', `clipboard read failed: ${err && err.message ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  // 点击卡片复制：写回剪贴板，同时更新基线并短暂抑制，避免「使用历史」回环
  async copyText(text) {
    this.suppressUntil = Date.now() + SELF_WRITE_SUPPRESS_MS;
    await clipboard.writeText(text);
    this.lastText = text;
    this.logger.info('watcher', 'self copy text');
  }

  async copyImage(pngBuffer) {
    this.suppressUntil = Date.now() + SELF_WRITE_SUPPRESS_MS;
    await clipboard.write([
      new ClipboardItem({
        'image/png': new Blob([pngBuffer]),
      }),
    ]);
    this.lastImageHash = sha256(pngBuffer);
    this.logger.info('watcher', 'self copy image');
  }
}

module.exports = { ClipboardWatcher, sha256, POLL_MS, IMAGE_READ_MS, MAX_TEXT_CHARS, MAX_IMAGE_BYTES };
