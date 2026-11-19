'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  dialog,
  nativeImage,
  screen,
  session,
} = require('electron');

const { initPaths } = require('./paths');
const { createLogger } = require('./logger');
const { ClipboardWatcher } = require('./clipboard-watcher');
const { runSelfTest } = require('./selftest');

const IS_SELF_TEST = process.argv.includes('--selftest');
const IS_PATHS_CHECK = process.argv.includes('--paths-check');
const IS_UTILITY_RUN = IS_SELF_TEST || IS_PATHS_CHECK;
const START_HIDDEN = process.argv.includes('--hidden');

const MAX_SESSION_ITEMS = 50;
const MAX_SESSION_IMAGE_BYTES = 8 * 1024 * 1024;

let paths = null;
let logger = null;
let watcher = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
const sessionItems = new Map();

if (!IS_UTILITY_RUN && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (!IS_UTILITY_RUN) {
    app.on('second-instance', () => {
      showMainWindow();
    });
  }
  boot();
}

function boot() {
  try {
    paths = initPaths();
    logger = createLogger(paths.logsDir);
  } catch (err) {
    dialog.showErrorBox(
      '数据文件夹无法写入',
      '无法在程序所在文件夹创建数据目录。\n' +
        '请将程序移动到有写入权限的普通文件夹后重试（不要放在 Program Files 或只读位置）。\n\n' +
        `详细信息：${err && err.message ? err.message : err}`
    );
    app.exit(1);
    return;
  }

  app.setAppUserModelId('com.local.clipboardhistory');

  watcher = new ClipboardWatcher({ logger });
  watcher.on('capture', handleCapture);
  watcher.on('oversized', (info) => {
    logger.warn('app', `oversized content skipped type=${info.type}`);
  });

  app.whenReady().then(async () => {
    if (IS_PATHS_CHECK) {
      const info = {
        isPackaged: app.isPackaged,
        version: app.getVersion(),
        execPath: process.execPath,
        resourcesPath: process.resourcesPath,
        dataDir: paths.dataDir,
        userData: app.getPath('userData'),
        sessionData: app.getPath('sessionData'),
      };
      try {
        fs.writeFileSync(path.join(paths.dataDir, 'paths-check.json'), JSON.stringify(info, null, 2), 'utf8');
      } catch {
        // 忽略
      }
      logger.info('app', `paths-check dataDir=${paths.dataDir}`);
      app.exit(0);
      return;
    }

    if (IS_SELF_TEST) {
      const cpuArg = process.argv.find((arg) => arg.startsWith('--cpu-test='));
      const cpuSeconds = cpuArg ? Number(cpuArg.split('=')[1]) || 0 : 0;
      const exitCode = await runSelfTest({ watcher, logger, dataDir: paths.dataDir, cpuSeconds });
      app.exit(exitCode);
      return;
    }

    setupIpc();
    hardenNetwork();
    createMainWindow();
    createTray();
    watcher.start();
    logger.info('app', `started version=${app.getVersion()} packaged=${app.isPackaged} dataDir=${paths.dataDir}`);
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (watcher) watcher.stop();
  });

  // 托盘应用：窗口全部隐藏/关闭时不退出
  app.on('window-all-closed', () => {});
}

function hardenNetwork() {
  // 生产环境阻断一切 http/https 请求（本应用无联网功能）
  if (!app.isPackaged) return;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/i.test(details.url || '')) {
      callback({ cancel: true });
      return;
    }
    callback({});
  });
}

function resolveAsset(name) {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(app.getAppPath(), 'assets');
  return path.join(base, name);
}

function createMainWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const height = Math.min(620, Math.max(500, Math.floor(workArea.height * 0.9)));

  mainWindow = new BrowserWindow({
    width: 420,
    height,
    minWidth: 360,
    minHeight: 500,
    maximizable: false,
    resizable: true,
    frame: false,
    icon: resolveAsset('app-icon.png'),
    backgroundColor: '#0B1E36',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (!START_HIDDEN) mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  let icon = nativeImage.createFromPath(resolveAsset('tray-32.png'));
  if (icon.isEmpty()) {
    icon = nativeImage.createFromPath(resolveAsset('icon.png'));
  }
  tray = new Tray(icon);
  tray.setToolTip('历史剪贴板');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开窗口', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      showMainWindow();
    }
  });
  logger.info('app', 'tray created');
}

function handleCapture(capture) {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  let dto;

  if (capture.type === 'text') {
    dto = {
      id,
      type: 'text',
      createdAt,
      previewText: capture.text.slice(0, 500),
      chars: capture.text.length,
    };
    sessionItems.set(id, { type: 'text', text: capture.text });
  } else {
    let thumbDataUrl = '';
    try {
      const image = nativeImage.createFromBuffer(capture.buffer);
      const width = image.getSize().width;
      const thumb = width > 320 ? image.resize({ width: 320, quality: 'good' }) : image;
      thumbDataUrl = thumb.toDataURL();
    } catch {
      // 缩略图失败不阻塞采集
    }
    dto = {
      id,
      type: 'image',
      createdAt,
      width: capture.width,
      height: capture.height,
      bytes: capture.buffer.length,
      thumbDataUrl,
    };
    if (capture.buffer.length <= MAX_SESSION_IMAGE_BYTES) {
      sessionItems.set(id, { type: 'image', buffer: capture.buffer });
    }
  }

  while (sessionItems.size > MAX_SESSION_ITEMS) {
    const oldestKey = sessionItems.keys().next().value;
    sessionItems.delete(oldestKey);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('debug:capture', dto);
  }
  logger.info('app', `session capture id=${id.slice(0, 8)} type=${capture.type}`);
}

function setupIpc() {
  ipcMain.on('win:hide', () => {
    if (mainWindow) mainWindow.hide();
  });

  ipcMain.handle('debug:get-status', async () => {
    const usage = process.getCPUUsage();
    let memoryKB = 0;
    try {
      const memory = await process.getProcessMemoryInfo();
      memoryKB = memory.residentSet;
    } catch {
      // 忽略
    }
    return {
      version: app.getVersion(),
      packaged: app.isPackaged,
      dataDir: paths.dataDir,
      cpuPercent: Math.round(usage.percentCPUUsage * 10) / 10,
      memoryMB: Math.round((memoryKB / 1024) * 10) / 10,
      stats: { ...watcher.stats },
      lastTypes: watcher.lastTypes,
      baselineDone: watcher.baselineDone,
    };
  });

  ipcMain.handle('debug:copy', async (_event, payload) => {
    try {
      const id = payload && typeof payload.id === 'string' ? payload.id : '';
      const entry = sessionItems.get(id);
      if (!entry) return { ok: false, error: '条目已失效' };
      if (entry.type === 'text') {
        await watcher.copyText(entry.text);
      } else {
        await watcher.copyImage(entry.buffer);
      }
      return { ok: true };
    } catch (err) {
      logger.warn('ipc', `copy failed: ${err && err.message ? err.message : err}`);
      return { ok: false, error: '复制失败，请重试' };
    }
  });
}
