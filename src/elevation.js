import { cumulativeDistances } from './gpx.js';

export function renderElevationProfile(canvasId, points) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height - 28; // account for stats bar

  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  const pad = { top: 16, right: 16, bottom: 28, left: 52 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;

  const elevs = points.map(p => p.ele ?? 0);
  const dists = cumulativeDistances(points);
  const maxDist = dists[dists.length - 1] || 1;
  let minElev = Infinity, maxElev = -Infinity;
  for (const e of elevs) { if (e < minElev) minElev = e; if (e > maxElev) maxElev = e; }
  const elevRange = maxElev - minElev || 1;

  const toX = d => pad.left + (d / maxDist) * cw;
  const toY = e => pad.top + ch - ((e - minElev) / elevRange) * ch;

  // Background
  ctx.fillStyle = '#161625';
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = '#2a2a44';
  ctx.lineWidth = 0.5;
  const yTicks = niceScale(minElev, maxElev, 5);
  for (const v of yTicks) {
    const y = toY(v);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
  }
  const xTicks = niceScale(0, maxDist / 1000, 5);
  for (const v of xTicks) {
    const x = toX(v * 1000);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, H - pad.bottom);
    ctx.stroke();
  }

  // Gradient fill
  const grad = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
  grad.addColorStop(0, 'rgba(255,87,34,0.35)');
  grad.addColorStop(1, 'rgba(255,87,34,0.03)');

  ctx.beginPath();
  ctx.moveTo(toX(dists[0]), toY(elevs[0]));
  const step = Math.max(1, Math.floor(points.length / cw));
  for (let i = 1; i < points.length; i += step) {
    ctx.lineTo(toX(dists[i]), toY(elevs[i]));
  }
  const lastIdx = dists.length - 1;
  ctx.lineTo(toX(dists[lastIdx]), toY(elevs[lastIdx]));
  ctx.lineTo(toX(dists[lastIdx]), H - pad.bottom);
  ctx.lineTo(pad.left, H - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(toX(dists[0]), toY(elevs[0]));
  for (let i = 1; i < points.length; i += step) {
    ctx.lineTo(toX(dists[i]), toY(elevs[i]));
  }
  ctx.lineTo(toX(dists[lastIdx]), toY(elevs[lastIdx]));
  ctx.strokeStyle = '#ff5722';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Y axis labels
  ctx.fillStyle = '#8888aa';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of yTicks) {
    ctx.fillText(Math.round(v) + ' m', pad.left - 6, toY(v));
  }

  // X axis labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const v of xTicks) {
    ctx.fillText(v.toFixed(1) + ' km', toX(v * 1000), H - pad.bottom + 6);
  }
}

function niceScale(lo, hi, maxTicks) {
  const range = hi - lo || 1;
  const rough = range / maxTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = norm < 1.5 ? mag : norm < 3 ? 2 * mag : norm < 7 ? 5 * mag : 10 * mag;
  const start = Math.ceil(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi; v += step) ticks.push(v);
  return ticks;
}
