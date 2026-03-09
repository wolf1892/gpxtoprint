import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const baseDir = '/Users/manish/gpxexport';
let gpxPath = resolve(baseDir, 'foxboro.gpx');
if (!existsSync(gpxPath)) gpxPath = '/Users/manish/Downloads/foxboro.gpx';
if (!existsSync(gpxPath)) gpxPath = resolve(baseDir, 'sample.gpx');
if (!existsSync(gpxPath)) {
  console.error('No GPX file found');
  process.exit(1);
}

const gpxBuffer = readFileSync(gpxPath);
const gpxName = gpxPath.split('/').pop();
console.log('Using GPX:', gpxPath);

const consoleLogs = [];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage();
page.setViewportSize({ width: 1280, height: 900 });

page.on('console', (msg) => consoleLogs.push({ type: msg.type(), text: msg.text() }));
page.on('pageerror', (err) => consoleLogs.push({ type: 'pageerror', text: err.message }));

try {
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1000);

  await page.locator('#file-input').setInputFiles({
    name: gpxName,
    mimeType: 'application/gpx+xml',
    buffer: gpxBuffer,
  });

  await page.waitForFunction(
    () => document.getElementById('empty-state')?.classList.contains('hidden'),
    { timeout: 15000 }
  );
  await page.waitForTimeout(2000);

  await page.click('button[data-view="3d"]');
  await page.waitForTimeout(25000);

  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden'),
    { timeout: 5000 }
  ).catch(() => {});
  await page.waitForTimeout(2000);

  // Screenshot 1: initial 3D view
  await page.screenshot({
    path: resolve(baseDir, 'screenshot-3d-initial.png'),
    fullPage: true,
  });

  // Orbit: click and drag on the 3D canvas (three-container)
  const canvas = page.locator('#three-container canvas');
  const box = await canvas.boundingBox();
  if (box) {
    const midX = box.x + box.width / 2;
    const midY = box.y + box.height / 2;
    await page.mouse.move(midX, midY);
    await page.mouse.down();
    await page.mouse.move(midX + 80, midY - 60, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
  }

  // Screenshot 2: after orbit
  await page.screenshot({
    path: resolve(baseDir, 'screenshot-3d-orbited.png'),
    fullPage: true,
  });
} finally {
  await browser.close();
}

const errors = consoleLogs.filter(l => l.type === 'error' || l.type === 'pageerror');
console.log('\n=== CONSOLE ERRORS ===');
console.log(errors.length ? errors.map(e => e.text).join('\n') : '(none)');
