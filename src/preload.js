'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const EVENTS = ['state', 'ocr', 'navigate'];

contextBridge.exposeInMainWorld('rk', {
  state: () => invoke('state:get'),
  updateSettings: (partial) => invoke('settings:update', partial),
  captureHotkey: () => invoke('hotkey:capture'),
  pauseHotkey: () => invoke('hotkey:pause'),
  resumeHotkey: () => invoke('hotkey:resume'),
  setSafeHotkey: (a) => invoke('hotkey:setSafe', a),
  pickRegion: (delayMs) => invoke('region:pick', delayMs),
  testOcr: () => invoke('ocr:test'),
  detectFolder: () => invoke('folder:detect'),
  chooseFolder: () => invoke('dialog:folder'),
  markNow: () => invoke('mark:manual'),
  updateMark: (id, patch) => invoke('mark:update', id, patch),
  deleteMark: (id) => invoke('mark:delete', id),
  clearMarks: () => invoke('data:clearMarks'),
  buildReport: (draft) => invoke('report:build', draft),
  saveReport: (draft) => invoke('report:save', draft),
  deleteReport: (id) => invoke('report:delete', id),
  copy: (text) => invoke('clipboard:write', text),
  showFile: (p) => invoke('shell:show', p),
  openLog: () => invoke('shell:openLog'),
  openData: () => invoke('shell:openData'),
  recentLog: () => invoke('log:recent'),
  usage: () => invoke('usage:get'),
  checkUpdate: () => invoke('update:check'),
  installUpdate: () => invoke('update:install'),
  windows: () => invoke('windows:list'),
  attach: (id, kind) => invoke('mark:attach', id, kind),
  chooseRecordDir: () => invoke('record:chooseDir'),
  openRecordDir: () => invoke('record:openDir'),
  displays: () => invoke('displays:list'),
  dragFile: (p) => ipcRenderer.send('file:drag', p),
  on: (channel, cb) => {
    if (!EVENTS.includes(channel)) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
