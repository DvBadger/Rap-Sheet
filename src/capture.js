'use strict';
// Screen capture helpers (Electron main process). Reads pixels only, the same way OBS captures a display:
// it never touches the game's process, memory or files.
const { desktopCapturer, screen } = require('electron');
const { fractionRect, pickWindowName } = require('./lib/region');

function pickDisplay(displayId) {
  const all = screen.getAllDisplays();
  return all.find((d) => d.id === displayId) || screen.getPrimaryDisplay();
}

async function grabDisplay(display) {
  const sf = display.scaleFactor || 1;
  const size = { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!src || !src.thumbnail || src.thumbnail.isEmpty()) return null;
  return src.thumbnail;
}

// ---- game-window capture: only that window's own picture, so Discord, overlays and other windows on top never appear.
const SELF = /^Rap Sheet$/i;

async function listWindows() {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    const name = String(s.name || '').trim();
    if (!name || SELF.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function looksBlack(img) {
  try {
    const small = img.resize({ width: 32, height: 18, quality: 'good' });
    const px = small.toBitmap();
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
    return sum / (px.length / 4 * 3) < 2.5;
  } catch (e) { return false; }
}

// Returns {img} or {error}. Never falls back to the whole screen.
async function grabWindow(wanted) {
  if (!wanted) return { error: 'Choose your game window in Settings first.' };
  let sources;
  try {
    sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 3840, height: 2160 } });
  } catch (e) { return { error: 'Window capture failed: ' + (e && e.message) }; }
  const names = sources.map((s) => s.name);
  const name = pickWindowName(wanted, names);
  if (!name) return { error: 'Game window "' + wanted + '" was not found. Start the game (not minimized) and pick it again in Settings.' };
  const src = sources.find((s) => s.name === name);
  if (!src || !src.thumbnail || src.thumbnail.isEmpty()) return { error: 'The game window is minimized or has no picture yet.' };
  if (looksBlack(src.thumbnail)) return { error: 'The game window came back black. Run the game in borderless windowed mode.' };
  return { img: src.thumbnail, name };
}

// region = {displayId, x, y, width, height} in DIP relative to that display's top-left.
async function captureRegion(region, scale, gameWindow) {
  if (gameWindow) {
    const g = await grabWindow(gameWindow);
    if (g.error) return { error: g.error };
    const size = g.img.getSize();
    const rect = fractionRect(region, size.width, size.height);
    if (!rect) return { error: 'Pick the reading area again (drag a box inside the game window).' };
    return finishCrop(g.img.crop(rect), rect, scale);
  }
  return { error: 'Choose your game window in Settings first, so only the game is read.' };
}

function finishCrop(crop, rect, scale) {
  const preview = crop.getSize().width > 560 ? crop.resize({ width: 560, quality: 'good' }) : crop;
  const previewDataUrl = preview.toDataURL();
  const factor = scale && scale > 1 ? scale : 1;
  if (factor !== 1) crop = crop.resize({ width: Math.round(rect.width * factor), height: Math.round(rect.height * factor), quality: 'best' });
  return { png: crop.toPNG(), previewDataUrl };
}

// Legacy whole-display capture. No longer used by default; kept only for the self-test.
async function captureRegionDisplay(region, scale) {
  if (!region || !(region.width > 4) || !(region.height > 4)) return null;
  const display = pickDisplay(region.displayId);
  const img = await grabDisplay(display);
  if (!img) return null;
  const sf = display.scaleFactor || 1;
  const full = img.getSize();
  const rect = {
    x: Math.max(0, Math.round(region.x * sf)),
    y: Math.max(0, Math.round(region.y * sf)),
    width: Math.round(region.width * sf),
    height: Math.round(region.height * sf)
  };
  rect.width = Math.min(rect.width, full.width - rect.x);
  rect.height = Math.min(rect.height, full.height - rect.y);
  if (rect.width < 4 || rect.height < 4) return null;
  let crop = img.crop(rect);
  const preview = crop.getSize().width > 560 ? crop.resize({ width: 560, quality: 'good' }) : crop;
  const previewDataUrl = preview.toDataURL();
  const factor = scale && scale > 1 ? scale : 1;
  if (factor !== 1) {
    crop = crop.resize({ width: Math.round(rect.width * factor), height: Math.round(rect.height * factor), quality: 'best' });
  }
  return { png: crop.toPNG(), previewDataUrl };
}

// Full-screen JPEG of the display that holds the region (or the primary display), capped at 2560px wide.
async function screenshotJpeg(gameWindow) {
  // Only the game window. If it can't be captured we save no screenshot rather than the whole desktop.
  const g = await grabWindow(gameWindow);
  if (g.error) return null;
  let img = g.img;
  if (img.getSize().width > 2560) img = img.resize({ width: 2560, quality: 'good' });
  return img.toJPEG(85);
}

// For the region picker: a frozen picture of the game window (returns {dataUrl, width, height} or {error}).
async function windowBackdrop(gameWindow) {
  const g = await grabWindow(gameWindow);
  if (g.error) return { error: g.error };
  let img = g.img;
  if (img.getSize().width > 1920) img = img.resize({ width: 1920, quality: 'good' });
  const s = img.getSize();
  return { dataUrl: 'data:image/jpeg;base64,' + img.toJPEG(80).toString('base64'), width: s.width, height: s.height };
}

// For the region picker: a downsized frozen picture of the display.
async function pickerBackdrop(display) {
  let img = await grabDisplay(display);
  if (!img) return '';
  if (img.getSize().width > 1920) img = img.resize({ width: 1920, quality: 'good' });
  return 'data:image/jpeg;base64,' + img.toJPEG(80).toString('base64');
}

module.exports = { captureRegion, captureRegionDisplay, screenshotJpeg, pickerBackdrop, windowBackdrop, listWindows, pickDisplay };
