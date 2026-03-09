import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const baseDir = '/Users/manish/gpxexport';

// Find GPX file: test.gpx -> workspace .gpx -> Downloads
let gpxPath = resolve(baseDir, 'test.gpx');
if (!existsSync(gpxPath)) {
  gpxPath = resolve(baseDir, 'sample.gpx');
}
if (!existsSync(gpxPath)) {
  gpxPath = '/Users/manish/Downloads/foxboro.gpx';
}
if (!existsSync(gpxPath)) {
  console.error('No GPX file found');
  process.exit(1);
}

const gpxBuffer = readFileSync(gpxPath);
const gpxName = gpxPath.split('/').pop();
console.log('Using GPX file:', gpxPath);

const consoleLogs = [];
const consoleErrors = [];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage();
page.setViewportSize({ width: 1280, height: 900 });

page.on('console', (msg) => {
  const text = msg.text();
  const type = msg.type();
  consoleLogs.push({ type, text });
  if (type === 'error') consoleErrors.push(text);
});
page.on('pageerror', (err) => consoleErrors.push(err.message));

try {
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1500);

  // Upload GPX
  await page.locator('#file-input').setInputFiles({
    name: gpxName,
    mimeType: 'application/gpx+xml',
    buffer: gpxBuffer,
  });

  await page.waitForFunction(
    () => document.getElementById('empty-state')?.classList.contains('hidden'),
    { timeout: 10000 }
  );
  await page.waitForTimeout(2500);

  // Screenshot map view
  await page.screenshot({
    path: resolve(baseDir, 'screenshot-map-view.png'),
    fullPage: true,
  });

  // Capture stats from map view
  const statsMap = await page.evaluate(() => ({
    distance: document.getElementById('stat-distance')?.textContent,
    gain: document.getElementById('stat-gain')?.textContent,
    loss: document.getElementById('stat-loss')?.textContent,
    max: document.getElementById('stat-max')?.textContent,
    min: document.getElementById('stat-min')?.textContent,
    speed: document.getElementById('stat-speed')?.textContent,
    time: document.getElementById('stat-time')?.textContent,
  }));
  console.log('Stats (map view):', statsMap);

  // Click 3D tab
  await page.click('button[data-view="3d"]');

  // Wait 15-20 seconds for terrain
  await page.waitForTimeout(18000);

  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden'),
    { timeout: 5000 }
  ).catch(() => {});

  await page.waitForTimeout(2000);

  // Screenshot 3D view
  await page.screenshot({
    path: resolve(baseDir, 'screenshot-3d-view.png'),
    fullPage: true,
  });

  const stats3d = await page.evaluate(() => ({
    distance: document.getElementById('stat-distance')?.textContent,
    gain: document.getElementById('stat-gain')?.textContent,
    speed: document.getElementById('stat-speed')?.textContent,
    time: document.getElementById('stat-time')?.textContent,
  }));
  console.log('Stats (3D view):', stats3d);

  const has3dContent = await page.evaluate(() => {
    const container = document.getElementById('three-container');
    const canvas = container?.querySelector('canvas');
    return { hasCanvas: !!canvas, childCount: container?.children.length || 0 };
  });
  console.log('3D container:', has3dContent);
} finally {
  await browser.close();
}

console.log('\n=== CONSOLE ERRORS ===');
console.log(consoleErrors.length ? consoleErrors.join('\n') : '(none)');
