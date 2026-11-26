'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rec', {
  chunk: (ab) => ipcRenderer.send('rec:chunk', ab),
  stats: (s) => ipcRenderer.send('rec:stats', s),
  stopped: () => ipcRenderer.send('rec:stopped')
});
