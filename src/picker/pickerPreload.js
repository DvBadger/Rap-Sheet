'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pk', {
  onInit: (cb) => ipcRenderer.on('picker:init', (_e, payload) => cb(payload)),
  done: (rect) => ipcRenderer.send('picker:done', rect)
});
