import './style.css';
import { parseGPX, flattenPoints, computeStats, formatTime } from './gpx.js';
import { initMap, displayTrack } from './map.js';
import { renderElevationProfile } from './elevation.js';
import { TerrainBuilder } from './terrain.js';
import { Preview3D } from './preview3d.js';

const ORDER_EMAIL = 'your-email@example.com';

let gpxData = null;
let terrainBuilder = null;
let preview3d = null;
let currentView = 'map';
let cachedStats = null;

const $ = id => document.getElementById(id);

const uploadBtn = $('upload-btn');
const fileInput = $('file-input');
const exportBtn = $('export-btn');
const mapTab = $('map-tab');
const threeDTab = $('3d-tab');
const mapContainer = $('map-container');
const threeContainer = $('three-container');
const emptyState = $('empty-state');
const loading = $('loading');
const loadingText = $('loading-text');
const settingsToggle = $('settings-toggle');
const settingsEl = $('settings');
const rebuildBtn = $('rebuild-btn');
const dropzone = $('dropzone');

const sliders = {
  exaggeration: { el: $('exaggeration'), out: $('exag-val'), fmt: v => v + '\u00d7' },
  trackWidth: { el: $('track-width'), out: $('tw-val'), fmt: v => v + ' mm' },
  trackHeight: { el: $('track-height'), out: $('th-val'), fmt: v => v + ' mm' },
  baseHeight: { el: $('base-height'), out: $('bh-val'), fmt: v => v + ' mm' },
  modelSize: { el: $('model-size'), out: $('ms-val'), fmt: v => v + ' mm' },
  gridResolution: { el: $('grid-resolution'), out: $('gr-val'), fmt: v => v },
};

for (const [, s] of Object.entries(sliders)) {
  s.el.addEventListener('input', () => { s.out.textContent = s.fmt(s.el.value); });
}

function getSettings() {
  return {
    exaggeration: parseFloat(sliders.exaggeration.el.value),
    trackWidth: parseFloat(sliders.trackWidth.el.value),
    trackHeight: parseFloat(sliders.trackHeight.el.value),
    baseHeight: parseFloat(sliders.baseHeight.el.value),
    modelSize: parseFloat(sliders.modelSize.el.value),
    gridResolution: parseInt(sliders.gridResolution.el.value),
  };
}

const map = initMap('map-container');

uploadBtn.addEventListener('click', () => fileInput.click());
emptyState.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => handleFile(e.target.files[0]));

let dragCounter = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); dragCounter++; dropzone.classList.remove('hidden'); });
document.addEventListener('dragleave', e => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dropzone.classList.add('hidden'); dragCounter = 0; } });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault(); dragCounter = 0; dropzone.classList.add('hidden');
  const f = e.dataTransfer?.files?.[0];
  if (f && f.name.toLowerCase().endsWith('.gpx')) handleFile(f);
});

async function handleFile(file) {
  if (!file) return;
  const text = await file.text();
  gpxData = parseGPX(text);

  if (!gpxData.tracks.length || !gpxData.tracks.some(t => t.segments.length)) {
    alert('No tracks found in this GPX file.');
    return;
  }

  $('file-name').textContent = file.name;
  emptyState.classList.add('hidden');
  exportBtn.disabled = false;
  rebuildBtn.disabled = false;
  podBtn.disabled = false;

  displayTrack(gpxData);

  const pts = flattenPoints(gpxData);
  renderElevationProfile('elevation-canvas', pts);

  const stats = computeStats(pts);
  stats.trackName = gpxData.tracks[0]?.name || '';
  cachedStats = stats;

  $('stat-distance').textContent = (stats.distance / 1000).toFixed(2) + ' km';
  $('stat-gain').textContent = Math.round(stats.elevGain) + ' m';
  $('stat-loss').textContent = Math.round(stats.elevLoss) + ' m';
  $('stat-max').textContent = Math.round(stats.maxElev) + ' m';
  $('stat-min').textContent = Math.round(stats.minElev) + ' m';
  $('stat-speed').textContent = stats.avgSpeed > 0 ? stats.avgSpeed.toFixed(2) + ' / ' + stats.movingSpeed.toFixed(2) + ' km/h' : '\u2014';
  $('stat-time').textContent = stats.totalTimeSec > 0 ? formatTime(stats.movingTimeSec) + ' / ' + formatTime(stats.totalTimeSec) : '\u2014';

  terrainBuilder = null;
}

mapTab.addEventListener('click', () => switchView('map'));
threeDTab.addEventListener('click', () => switchView('3d'));

async function switchView(view) {
  currentView = view;
  mapTab.classList.toggle('active', view === 'map');
  threeDTab.classList.toggle('active', view === '3d');
  mapContainer.classList.toggle('active', view === 'map');
  threeContainer.classList.toggle('active', view === '3d');
  if (view === '3d' && gpxData) await build3D();
}

async function build3D() {
  if (!gpxData) return;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  showLoading('Fetching terrain elevation\u2026');
  try {
    terrainBuilder = new TerrainBuilder(gpxData, getSettings(), cachedStats);
    await terrainBuilder.build(progress => {
      loadingText.textContent = `Loading terrain\u2026 ${Math.round(progress * 100)}%`;
    });
    if (!preview3d) preview3d = new Preview3D('three-container');
    await new Promise(r => requestAnimationFrame(r));
    preview3d.setTerrain(terrainBuilder);
  } catch (err) {
    console.error('3D build failed:', err);
    alert('Failed to generate 3D terrain: ' + err.message);
  } finally {
    hideLoading();
  }
}

settingsToggle.addEventListener('click', () => settingsEl.classList.toggle('collapsed'));
rebuildBtn.addEventListener('click', async () => { terrainBuilder = null; if (currentView === '3d') await build3D(); });

exportBtn.addEventListener('click', async () => {
  if (!gpxData) return;
  showLoading('Generating STL\u2026');
  try {
    if (!terrainBuilder) {
      terrainBuilder = new TerrainBuilder(gpxData, getSettings(), cachedStats);
      await terrainBuilder.build(p => { loadingText.textContent = `Loading terrain\u2026 ${Math.round(p * 100)}%`; });
    }
    loadingText.textContent = 'Writing STL\u2026';
    await new Promise(r => setTimeout(r, 50));
    const buffer = terrainBuilder.exportSTL();
    download(buffer, 'track-terrain.stl', 'application/octet-stream');
  } catch (err) {
    console.error('Export failed:', err);
    alert('Export failed: ' + err.message);
  } finally {
    hideLoading();
  }
});

function download(data, name, mime) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

function showLoading(text) { loadingText.textContent = text || 'Loading\u2026'; loading.classList.remove('hidden'); }
function hideLoading() { loading.classList.add('hidden'); }

window.addEventListener('resize', () => {
  if (gpxData) renderElevationProfile('elevation-canvas', flattenPoints(gpxData));
});

/* ── Print on Demand modal ── */

const podBtn = $('pod-btn');
const podModal = $('pod-modal');
const podClose = $('pod-close');
const podCancel = $('pod-cancel');
const podPay = $('pod-pay');
const podTrackName = $('pod-track-name');

const podFields = {
  name: $('pod-name'),
  email: $('pod-email'),
  addr1: $('pod-addr1'),
  addr2: $('pod-addr2'),
  city: $('pod-city'),
  state: $('pod-state'),
  zip: $('pod-zip'),
  country: $('pod-country'),
};

function openPodModal() {
  podTrackName.textContent = cachedStats?.trackName || gpxData?.tracks?.[0]?.name || 'Untitled Track';
  podModal.classList.remove('hidden');
}

function closePodModal() {
  podModal.classList.add('hidden');
  for (const f of Object.values(podFields)) f.classList.remove('field-error');
}

podBtn.addEventListener('click', openPodModal);
podClose.addEventListener('click', closePodModal);
podCancel.addEventListener('click', closePodModal);
podModal.addEventListener('click', e => { if (e.target === podModal) closePodModal(); });

podPay.addEventListener('click', () => {
  const required = ['name', 'email', 'addr1', 'city', 'zip', 'country'];
  let valid = true;
  for (const key of required) {
    const el = podFields[key];
    const empty = !el.value.trim();
    el.classList.toggle('field-error', empty);
    if (empty) valid = false;
  }
  if (!valid) return;

  const printType = document.querySelector('input[name="pod-type"]:checked').value;
  const trackName = podTrackName.textContent;
  const stats = cachedStats || {};
  const dist = stats.distance ? (stats.distance / 1000).toFixed(2) + ' km' : '—';
  const gain = stats.elevGain ? Math.round(stats.elevGain) + ' m' : '—';

  const body = [
    '=== PRINT ON DEMAND ORDER ===',
    '',
    `Track: ${trackName}`,
    `Distance: ${dist}`,
    `Elevation Gain: ${gain}`,
    `Print Type: ${printType === 'color' ? 'Colour' : 'Monochrome'}`,
    '',
    '--- Shipping ---',
    `Name: ${podFields.name.value.trim()}`,
    `Email: ${podFields.email.value.trim()}`,
    `Address: ${podFields.addr1.value.trim()}`,
    podFields.addr2.value.trim() ? `         ${podFields.addr2.value.trim()}` : null,
    `City: ${podFields.city.value.trim()}`,
    podFields.state.value.trim() ? `State: ${podFields.state.value.trim()}` : null,
    `Pincode/ZIP: ${podFields.zip.value.trim()}`,
    `Country: ${podFields.country.value.trim()}`,
  ].filter(Boolean).join('\n');

  const subject = `Print on Demand: ${trackName}`;
  const mailto = `mailto:${ORDER_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.open(mailto, '_blank');

  closePodModal();
  alert('Your email client should open with the order details. Send the email to complete your order.');
});
