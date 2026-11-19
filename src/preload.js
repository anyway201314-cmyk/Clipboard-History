'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('监听回调必须是函数');
  }
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  hideWindow: () => {
    ipcRenderer.send('win:hide');
  },
  getStatus: () => ipcRenderer.invoke('debug:get-status'),
  queryItems: (options) => {
    const safe = options && typeof options === 'object' ? options : {};
    return ipcRenderer.invoke('items:query', {
      search: typeof safe.search === 'string' ? safe.search : '',
      offset: Number.isInteger(safe.offset) ? safe.offset : 0,
      limit: Number.isInteger(safe.limit) ? safe.limit : 100,
    });
  },
  copyItem: (id) => ipcRenderer.invoke('items:copy', { id }),
  pinItem: (id, pinned) => ipcRenderer.invoke('items:pin', { id, pinned: Boolean(pinned) }),
  removeItem: (id) => ipcRenderer.invoke('items:remove', { id }),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => {
    const safe = patch && typeof patch === 'object' ? patch : {};
    const payload = {};
    if ('retentionDays' in safe) payload.retentionDays = safe.retentionDays;
    if ('launchAtLogin' in safe) payload.launchAtLogin = Boolean(safe.launchAtLogin);
    return ipcRenderer.invoke('settings:update', payload);
  },
  clearHistory: () => ipcRenderer.invoke('items:clear'),
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
  onItemsChanged: (callback) => subscribe('items:changed', callback),
  onError: (callback) => subscribe('app:error', callback),
});
