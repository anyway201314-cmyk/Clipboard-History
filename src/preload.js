'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  hideWindow: () => {
    ipcRenderer.send('win:hide');
  },
  getStatus: () => ipcRenderer.invoke('debug:get-status'),
  copyItem: (id) => ipcRenderer.invoke('debug:copy', { id }),
  onCapture: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('onCapture 需要函数参数');
    }
    const listener = (_event, dto) => callback(dto);
    ipcRenderer.on('debug:capture', listener);
    return () => ipcRenderer.removeListener('debug:capture', listener);
  },
});
