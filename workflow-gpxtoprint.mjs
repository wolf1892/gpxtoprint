import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const gpxPath = '/Users/manish/Downloads/fells_loop.gpx';
if (!existsSync(gpxPath)) {
  console.error('fells_loop.gpx not found');
  process.exit(1);
}

const gpxBuffer = readFileSync(gpxPath);
const baseDir = '/Users/manish/gpxexport';
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
  // Step 1-2: Navigate to gpxtoprint, screenshot home
  await page.goto('http://localhost:3000/gpxtoprint/', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: resolve(baseDir, 'gpxtoprint-1-home.png'), fullPage: true });
  console.log('Step 2: Home page screenshot saved');

  // Step 3-4: Upload GPX
  await page.locator('#file-input').setInputFiles({
    name: 'fells_loop.gpx',
    mimeType: 'application/gpx+xml',
    buffer: gpxBuffer,
  });

  await page.waitForFunction(
    () => document.getElementById('empty-state')?.classList.contains('hidden'),
    { timeout: 20000 }
  );
  await page.waitForTimeout(3000);

  // Step 5: Screenshot after GPX loaded
  await page.screenshot({ path: resolve(baseDir, 'gpxtoprint-2-map-loaded.png'), fullPage: true });
  console.log('Step 5: Map loaded screenshot saved');

  // Step 6: Click 3D tab
  await page.click('button[data-view="3d"]');
  console.log('Step 6: Clicked 3D tab');

  // Step 7: Wait 5-10 seconds for 3D terrain
  await page.waitForTimeout(8000);

  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden'),
    { timeout: 15000 }
  ).catch(() => {});
  await page.waitForTimeout(2000);

  // Step 8: Screenshot 3D view
  await page.screenshot({ path: resolve(baseDir, 'gpxtoprint-3-3d-view.png'), fullPage: true });
  console.log('Step 8: 3D view screenshot saved');

  // Step 9: Click Export OBJ, screenshot
  const exportBtn = page.locator('#export-btn');
  const isDisabled = await exportBtn.getAttribute('disabled');
  console.log('Export OBJ disabled?', !!isDisabled);

  if (!isDisabled) {
    await exportBtn.click();
    await page.waitForTimeout(2000);
  }
  await page.screenshot({ path: resolve(baseDir, 'gpxtoprint-4-after-export.png'), fullPage: true });
  console.log('Step 9: After Export OBJ screenshot saved');
} finally {
  await browser.close();
}

const errors = consoleLogs.filter(l => l.type === 'error' || l.type === 'pageerror');
const warnings = consoleLogs.filter(l => l.type === 'warning');

console.log('\n=== CONSOLE ERRORS ===');
console.log(errors.length ? errors.map(e => e.text).join('\n') : '(none)');

console.log('\n=== CONSOLE WARNINGS ===');
console.log(warnings.length ? warnings.map(w => w.text).join('\n') : '(none)');

console.log('\n=== ALL CONSOLE MESSAGES ===');
consoleLogs.forEach(l => console.log(`[${l.type}] ${l.text}`));
