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
  protocol,
  nativeTheme,
  shell,
} = require('electron');

const { initPaths } = require('./paths');
const { createLogger } = require('./logger');
const { ClipboardWatcher } = require('./clipboard-watcher');
const { runSelfTest } = require('./selftest');
const { Store } = require('./store');
const { ItemService } = require('./items');
const { SettingsStore, validateRetentionDays } = require('./settings');
const { prepareImage } = require('./image-files');

const IS_SELF_TEST = process.argv.includes('--selftest');
const IS_PATHS_CHECK = process.argv.includes('--paths-check');
const IS_UTILITY_RUN = IS_SELF_TEST || IS_PATHS_CHECK;
const START_HIDDEN = process.argv.includes('--hidden');

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

// 自定义缩略图协议：必须在 app ready 之前注册 scheme 权限
protocol.registerSchemesAsPrivileged([
  { scheme: 'clipimg', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

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

    syncLoginItem(settingsStore.get());

    setupIpc();
    registerClipimgProtocol();
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

function syncLoginItem(settings) {
  try {
    if (!app.isPackaged) {
      logger.info('app', `login item skipped in dev (launchAtLogin=${settings.launchAtLogin})`);
      return;
    }
    app.setLoginItemSettings({
      openAtLogin: Boolean(settings.launchAtLogin),
      path: process.execPath,
      args: ['--hidden'],
    });
    logger.info('app', `login item synced launchAtLogin=${settings.launchAtLogin}`);
  } catch (err) {
    logger.warn('app', `setLoginItemSettings failed: ${err && err.message ? err.message : err}`);
  }
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
    backgroundMaterial: 'acrylic',
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

  mainWindow.webContents.on('did-finish-load', () => {
    logger.info('app', 'renderer loaded');
  });
  mainWindow.webContents.on('console-message', (...args) => {
    try {
      let level;
      let message;
      let line;
      let sourceId;
      if (typeof args[1] === 'number') {
        [, level, message, line, sourceId] = args;
      } else {
        const details = args[1] || {};
        level = details.level;
        message = details.message;
        line = details.lineNumber;
        sourceId = details.sourceId;
      }
      const isError = level === 'error' || level === 3;
      const isWarning = level === 'warning' || level === 2;
      if (isError || isWarning) {
        logger.warn('renderer', `${message || '未知渲染层消息'} (${sourceId || 'unknown'}:${line || 0})`);
      }
    } catch {
      // 忽略
    }
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger.error('preload', `${preloadPath}: ${error && error.message ? error.message : error}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('renderer', `process gone reason=${details && details.reason ? details.reason : 'unknown'}`);
  });

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

function trayIcon() {
  // 任务栏深色 → 浅色图标；任务栏浅色 → 深色图标
  const name = nativeTheme.shouldUseDarkColors ? 'tray-32.png' : 'tray-dark-32.png';
  let icon = nativeImage.createFromPath(resolveAsset(name));
  if (icon.isEmpty()) {
    icon = nativeImage.createFromPath(resolveAsset('app-icon.png'));
  }
  return icon;
}

function createTray() {
  tray = new Tray(trayIcon());
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
  nativeTheme.on('updated', () => {
    if (tray && !tray.isDestroyed()) tray.setImage(trayIcon());
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
  return { ...dto, thumbUrl: `clipimg://thumb/${dto.image.thumb}` };
}

function registerClipimgProtocol() {
  protocol.handle('clipimg', async (request) => {
    try {
      const url = new URL(request.url);
      const kind = url.hostname;
      const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
      if (!/^[a-f0-9]{64}\.png$/.test(name)) {
        return new Response('bad request', { status: 400 });
      }
      let dir = null;
      if (kind === 'thumb') dir = paths.thumbsDir;
      else if (kind === 'image') dir = paths.imagesDir;
      else return new Response('not found', { status: 404 });

      const buffer = await fs.promises.readFile(path.join(dir, name));
      return new Response(buffer, {
        headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  logger.info('app', 'clipimg protocol registered');
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

  ipcMain.handle('items:pin', async (_event, payload) => {
    const id = payload && typeof payload.id === 'string' ? payload.id : '';
    const pinned = payload && typeof payload.pinned === 'boolean' ? payload.pinned : null;
    if (!id || pinned === null) return { ok: false, error: '参数无效' };

    const result = itemsService.setPinned(id, pinned);
    if (!result.ok) return { ok: false, error: result.error };

    store.flush().catch(() => notifySaveError());
    notifyItemsChanged();
    return { ok: true };
  });

  ipcMain.handle('items:remove', async (_event, payload) => {
    const id = payload && typeof payload.id === 'string' ? payload.id : '';
    if (!id) return { ok: false, error: '参数无效' };

    const item = itemsService.findById(id);
    if (!item) return { ok: false, error: '条目不存在' };

    if (item.pinned && mainWindow && !mainWindow.isDestroyed()) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '删除置顶内容',
        message: '这条内容已置顶，删除后无法恢复。确定删除吗？',
        buttons: ['取消', '删除'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) return { ok: true, removed: false, cancelled: true };
    }

    const result = itemsService.remove(id);
    if (!result.ok) return { ok: false, error: result.error };

    store.flush().catch(() => notifySaveError());
    notifyItemsChanged();
    return { ok: true, removed: true };
  });

  ipcMain.handle('settings:get', () => ({
    settings: settingsStore.get(),
    dataDir: paths.dataDir,
    version: app.getVersion(),
    packaged: app.isPackaged,
  }));

  ipcMain.handle('settings:update', async (_event, payload) => {
    const current = settingsStore.get();
    const patch = {};
    const input = payload && typeof payload === 'object' ? payload : {};

    if ('retentionDays' in input) {
      if (!validateRetentionDays(input.retentionDays)) {
        return { ok: false, error: '保存天数需为 1–30 的整数' };
      }
      patch.retentionDays = Number(input.retentionDays);

      if (patch.retentionDays < current.retentionDays) {
        const due = itemsService.countDueForRetention(patch.retentionDays);
        if (due > 0 && mainWindow && !mainWindow.isDestroyed()) {
          const { response } = await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: '缩短保存天数',
            message: `保存天数改为 ${patch.retentionDays} 天后，将清理 ${due} 条过期记录（置顶内容不受影响）。`,
            buttons: ['取消', '继续'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          if (response !== 1) return { ok: false, cancelled: true };
        }
      }
    }

    if ('launchAtLogin' in input) {
      patch.launchAtLogin = Boolean(input.launchAtLogin);
    }

    if (Object.keys(patch).length === 0) return { ok: false, error: '没有可更新的设置' };

    const result = settingsStore.update(patch);
    if (!result.ok) return result;

    if ('launchAtLogin' in patch) syncLoginItem(result.settings);

    if ('retentionDays' in patch) {
      const pruned = itemsService.prune({ retentionDays: result.settings.retentionDays, now: Date.now() });
      if (pruned.totalRemoved > 0) {
        store.flush().catch(() => notifySaveError());
        notifyItemsChanged();
        logger.info('settings', `retention updated to ${result.settings.retentionDays}, pruned=${pruned.totalRemoved}`);
      }
    }

    return { ok: true, settings: result.settings };
  });

  ipcMain.handle('items:clear', async () => {
    const stats = itemsService.stats();
    const removable = stats.total - stats.pinned;
    if (removable <= 0) return { ok: true, cleared: 0 };

    if (mainWindow && !mainWindow.isDestroyed()) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '清空历史',
        message: `将清空 ${removable} 条未置顶记录，置顶内容会保留。此操作无法撤销。`,
        buttons: ['取消', '清空'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) return { ok: true, cleared: 0, cancelled: true };
    }

    const result = itemsService.clearUnpinned();
    try {
      await store.flush({ syncBackup: true });
    } catch (err) {
      logger.error('items', `clear history flush failed: ${err && err.message ? err.message : err}`);
      notifySaveError();
    }
    notifyItemsChanged();
    logger.info('items', `clear history cleared=${result.cleared}`);
    return { ok: true, cleared: result.cleared };
  });

  ipcMain.handle('app:open-data-folder', async () => {
    try {
      const error = await shell.openPath(paths.dataDir);
      if (error) {
        logger.warn('app', `open data folder failed: ${error}`);
        return { ok: false, error: '无法打开数据文件夹' };
      }
      return { ok: true };
    } catch (err) {
      logger.warn('app', `open data folder failed: ${err && err.message ? err.message : err}`);
      return { ok: false, error: '无法打开数据文件夹' };
    }
  });
}
