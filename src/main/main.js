'use strict';

const fs = require('node:fs');
const path = require('node:path');
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
  powerMonitor,
} = require('electron');

const { initPaths } = require('./paths');
const { createLogger } = require('./logger');
const { ClipboardWatcher } = require('./clipboard-watcher');
const { runSelfTest } = require('./selftest');
const { Store } = require('./store');
const { ItemService } = require('./items');
const { SettingsStore } = require('./settings');
const { prepareImage } = require('./image-files');

const IS_SELF_TEST = process.argv.includes('--selftest');
const IS_PATHS_CHECK = process.argv.includes('--paths-check');
const IS_UTILITY_RUN = IS_SELF_TEST || IS_PATHS_CHECK;
const START_HIDDEN = process.argv.includes('--hidden');

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

let paths = null;
let logger = null;
let watcher = null;
let store = null;
let itemsService = null;
let settingsStore = null;
let mainWindow = null;
let tray = null;
let maintenanceTimer = null;
let isQuitting = false;
let allowQuit = false;
let pendingWarnings = [];
let lastError = null;

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

    try {
      await initDataLayer();
    } catch (err) {
      if (err && err.code === 'FUTURE_SCHEMA') {
        dialog.showErrorBox(
          '数据版本过新',
          '数据文件由更新版本的程序创建，当前程序为避免损坏数据已停止运行。\n请使用最新版本的程序打开。'
        );
      } else {
        dialog.showErrorBox(
          '数据加载失败',
          `无法加载历史数据：${err && err.message ? err.message : err}\n\n数据文件已保留，请不要删除 data 文件夹。`
        );
      }
      app.exit(1);
      return;
    }

    setupIpc();
    hardenNetwork();
    createMainWindow();
    createTray();
    watcher.start();
    startMaintenance();
    setupShutdownFlush();
    logger.info(
      'app',
      `started version=${app.getVersion()} packaged=${app.isPackaged} dataDir=${paths.dataDir} items=${itemsService.stats().total}`
    );
  });

  app.on('before-quit', (event) => {
    if (allowQuit) return;
    isQuitting = true;
    if (watcher) watcher.stop();
    if (maintenanceTimer) {
      clearInterval(maintenanceTimer);
      maintenanceTimer = null;
    }
    if (!store) return;

    event.preventDefault();
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    Promise.race([
      store.flush().catch((err) => {
        logger.error('store', `quit flush failed: ${err && err.message ? err.message : err}`);
      }),
      timeout,
    ]).finally(() => {
      allowQuit = true;
      app.quit();
    });
  });

  // 托盘应用：窗口全部隐藏/关闭时不退出
  app.on('window-all-closed', () => {});
}

async function initDataLayer() {
  settingsStore = new SettingsStore({ dataDir: paths.dataDir, logger });
  const settingsResult = settingsStore.load();

  store = new Store({ dataDir: paths.dataDir, logger, onSaveError: () => notifySaveError() });
  const loadResult = await store.load();
  if (store.dirty) store.markDirty();

  itemsService = new ItemService({
    store,
    imagesDir: paths.imagesDir,
    thumbsDir: paths.thumbsDir,
    logger,
  });

  const now = Date.now();
  const pruned = itemsService.prune({ retentionDays: settingsStore.get().retentionDays, now });
  if (pruned.totalRemoved > 0) logger.info('items', `startup prune removed=${pruned.totalRemoved}`);
  const orphans = itemsService.cleanupOrphanFiles();
  if (orphans > 0) logger.info('items', `orphan files removed=${orphans}`);
  if (pruned.totalRemoved > 0 || orphans > 0) {
    await store.flush().catch((err) => {
      logger.error('store', `startup save failed: ${err && err.message ? err.message : err}`);
    });
  }

  pendingWarnings = [...(settingsResult.warnings || []), ...(loadResult.warnings || [])];
}

function setupShutdownFlush() {
  try {
    powerMonitor.on('shutdown', () => {
      if (watcher) watcher.stop();
      if (store) store.flush().catch(() => {});
    });
  } catch {
    // powerMonitor 在部分环境不可用：忽略
  }
}

function startMaintenance() {
  maintenanceTimer = setInterval(async () => {
    try {
      const pruned = itemsService.prune({ retentionDays: settingsStore.get().retentionDays, now: Date.now() });
      const orphans = itemsService.cleanupOrphanFiles();
      if (pruned.totalRemoved > 0 || orphans > 0) {
        await store.flush();
        notifyItemsChanged();
        logger.info('maintenance', `pruned=${pruned.totalRemoved} orphans=${orphans}`);
      }
    } catch (err) {
      logger.error('maintenance', `failed: ${err && err.message ? err.message : err}`);
      notifySaveError();
    }
  }, MAINTENANCE_INTERVAL_MS);
}

function hardenNetwork() {
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
    icon = nativeImage.createFromPath(resolveAsset('app-icon.png'));
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
  if (!itemsService) return;

  let result = null;
  try {
    if (capture.type === 'text') {
      result = itemsService.ingestText(capture.text);
    } else {
      const prepared = prepareImage(capture.buffer);
      if (!prepared) {
        logger.warn('app', 'image decode failed, skipped');
        return;
      }
      result = itemsService.ingestImage({
        buffer: capture.buffer,
        hash: capture.hash,
        thumbBuffer: prepared.thumbBuffer,
        width: prepared.width,
        height: prepared.height,
      });
    }
  } catch (err) {
    logger.error('app', `ingest failed: ${err && err.message ? err.message : err}`);
    return;
  }

  if (!result || !result.ok) {
    logger.warn('app', `ingest skipped reason=${result && result.reason ? result.reason : 'unknown'}`);
    return;
  }

  notifyItemsChanged();
  logger.info('app', `item ${result.updated ? 'updated' : 'created'} id=${result.item.id.slice(0, 8)}`);
}

function notifyItemsChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('items:changed');
  }
}

function notifySaveError() {
  lastError = '数据保存失败，请检查磁盘空间或文件夹权限。';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:error', { message: lastError });
  }
}

function decorateDto(dto) {
  if (!dto || dto.type !== 'image' || !dto.image) return dto;
  let thumbDataUrl = '';
  try {
    const file = path.join(paths.thumbsDir, dto.image.thumb);
    if (fs.existsSync(file)) {
      thumbDataUrl = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
    }
  } catch {
    // 缩略图读取失败：保留空占位
  }
  return { ...dto, thumbDataUrl };
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
    const warnings = pendingWarnings.slice();
    if (lastError) warnings.push(lastError);

    return {
      version: app.getVersion(),
      packaged: app.isPackaged,
      dataDir: paths.dataDir,
      cpuPercent: Math.round(usage.percentCPUUsage * 10) / 10,
      memoryMB: Math.round((memoryKB / 1024) * 10) / 10,
      stats: { ...watcher.stats },
      lastTypes: watcher.lastTypes,
      baselineDone: watcher.baselineDone,
      stored: itemsService ? itemsService.stats() : null,
      warnings,
    };
  });

  ipcMain.handle('items:query', (_event, payload) => {
    const page = payload && typeof payload === 'object' ? payload : {};
    const search = typeof page.search === 'string' ? page.search.slice(0, 200) : '';
    const offset = Number.isInteger(page.offset) && page.offset >= 0 ? page.offset : 0;
    const limit = Number.isInteger(page.limit) && page.limit > 0 ? Math.min(page.limit, 200) : 100;
    const result = itemsService.query({ search, offset, limit });
    return { total: result.total, items: result.items.map(decorateDto) };
  });

  ipcMain.handle('items:copy', async (_event, payload) => {
    try {
      const id = payload && typeof payload.id === 'string' ? payload.id : '';
      const item = itemsService.findById(id);
      if (!item) return { ok: false, error: '条目不存在' };
      if (item.type === 'text') {
        await watcher.copyText(item.text);
      } else {
        const filePath = path.join(paths.imagesDir, item.image.file);
        const buffer = await fs.promises.readFile(filePath);
        await watcher.copyImage(buffer);
      }
      return { ok: true };
    } catch (err) {
      logger.warn('ipc', `copy failed: ${err && err.message ? err.message : err}`);
      return { ok: false, error: '复制失败，请重试' };
    }
  });
}
