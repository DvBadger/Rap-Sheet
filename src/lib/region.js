'use strict';
// A reading area is stored as fractions (0..1) of the game window's picture, so it keeps working
// when the window is resized or the picture comes back at a different resolution.

function toFractions(rect, boxW, boxH) {
  if (!(boxW > 0) || !(boxH > 0)) return null;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const fx = clamp(rect.x / boxW), fy = clamp(rect.y / boxH);
  const fw = Math.min(1 - fx, clamp(rect.width / boxW)), fh = Math.min(1 - fy, clamp(rect.height / boxH));
  if (fw <= 0 || fh <= 0) return null;
  return { rel: true, fx, fy, fw, fh };
}

// Pixel rectangle inside an image of imgW x imgH, or null when it would be too small to read.
function fractionRect(region, imgW, imgH) {
  if (!region || !region.rel) return null;
  const x = Math.round(region.fx * imgW), y = Math.round(region.fy * imgH);
  const width = Math.min(imgW - x, Math.round(region.fw * imgW));
  const height = Math.min(imgH - y, Math.round(region.fh * imgH));
  if (width < 4 || height < 4) return null;
  return { x, y, width, height };
}

// Does a window title match the one the user chose? Exact match first; otherwise one contains the other.
function pickWindowName(wanted, names) {
  const w = String(wanted || '').trim().toLowerCase();
  if (!w) return null;
  const list = names.map((n) => ({ n, l: String(n).toLowerCase() }));
  const exact = list.find((x) => x.l === w);
  if (exact) return exact.n;
  const part = list.find((x) => x.l.includes(w) || (x.l.length >= 4 && w.includes(x.l)));
  return part ? part.n : null;
}

module.exports = { toFractions, fractionRect, pickWindowName };
