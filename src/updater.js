'use strict';
// Automatic updates through GitHub Releases (electron-updater). Only active in the installed app, and only once a
// GitHub owner/repo has been filled in under "build.publish" in package.json. It never restarts the app on its own:
// a downloaded update installs when the app is quit, or when the user presses "Restart to update".
const { log } = require('./logger');

// Where releases are published. Kept in code on purpose: the installer strips the "build" section out of the
// packaged package.json, so the address cannot be read from there at run time.
const FEED = { provider: 'github', owner: 'DvBadger', repo: 'Rap-Sheet' };

function publishConfig() { return FEED; }

class Updater {
  constructor({ app, onChange }) {
    this.app = app;
    this.onChange = onChange || (() => {});
    this.state = { status: 'disabled', version: '', percent: 0, error: '', reason: '' };
    this.au = null;
    this.timer = null;
  }

  _set(patch) { this.state = { ...this.state, ...patch }; this.onChange(); }

  start() {
    if (!this.app.isPackaged || process.env.RK_SMOKE) { this._set({ status: 'disabled', reason: 'Updates only work in the installed app.' }); return; }
    if (!publishConfig()) { this._set({ status: 'disabled', reason: 'Update source is not set up yet.' }); return; }
    try {
      const { autoUpdater } = require('electron-updater');
      this.au = autoUpdater;
      autoUpdater.setFeedURL(FEED);
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.allowPrerelease = true; // the beta builds are published as prereleases
      autoUpdater.logger = { info: (m) => log('updater:', m), warn: (m) => log('updater warn:', m), error: (m) => log('updater error:', m), debug: () => {} };
      autoUpdater.on('checking-for-update', () => this._set({ status: 'checking', error: '' }));
      autoUpdater.on('update-available', (i) => this._set({ status: 'downloading', version: i.version, percent: 0 }));
      autoUpdater.on('update-not-available', () => this._set({ status: 'uptodate', error: '' }));
      autoUpdater.on('download-progress', (p) => this._set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
      autoUpdater.on('update-downloaded', (i) => this._set({ status: 'ready', version: i.version, percent: 100 }));
      autoUpdater.on('error', (e) => this._set({ status: 'error', error: String((e && e.message) || e).split('\n')[0].slice(0, 200) }));
      this._set({ status: 'idle', reason: '' });
      setTimeout(() => this.check(), 20000);
      this.timer = setInterval(() => this.check(), 6 * 60 * 60 * 1000);
    } catch (e) {
      log('updater could not start', e);
      this._set({ status: 'error', error: 'Updater could not start.' });
    }
  }

  async check() {
    if (!this.au || ['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state;
    try { await this.au.checkForUpdates(); } catch (e) { this._set({ status: 'error', error: String((e && e.message) || e).split('\n')[0].slice(0, 200) }); }
    return this.state;
  }

  install() {
    if (this.au && this.state.status === 'ready') { this.au.quitAndInstall(true, true); return true; }
    return false;
  }

  stop() { if (this.timer) clearInterval(this.timer); }
}

module.exports = { Updater, publishConfig, FEED };
