import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const gpxPath = '/Users/manish/Downloads/foxboro.gpx';
if (!existsSync(gpxPath)) {
  console.error('foxboro.gpx not found');
  process.exit(1);
}

const gpxBuffer = readFileSync(gpxPath);
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
    name: 'foxboro.gpx',
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
  await page.waitForTimeout(1500);

  // Screenshot 1: default top-down view
  await page.screenshot({
    path: resolve('/Users/manish/gpxexport', 'screenshot-3d-top.png'),
    fullPage: true,
  });

  // Orbit: multiple long drags DOWN to rotate camera below horizon (see underside).
  const canvas = page.locator('#three-container canvas');
  const box = await canvas.boundingBox();
  if (box) {
    const midX = box.x + box.width / 2;
    const midY = box.y + box.height / 2;
    // Drag 1: down 250px
    await page.mouse.move(midX, midY);
    await page.mouse.down();
    await page.mouse.move(midX, midY + 250, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    // Drag 2: more down from new center
    const y2 = midY + 120;
    await page.mouse.move(midX, y2);
    await page.mouse.down();
    await page.mouse.move(midX, y2 + 180, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    // Drag 3: horizontal to get side angle on base
    await page.mouse.move(midX, y2 + 100);
    await page.mouse.down();
    await page.mouse.move(midX + 100, y2 + 100, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
  }

  // Screenshot 2: underside/base view
  await page.screenshot({
    path: resolve('/Users/manish/gpxexport', 'screenshot-3d-underside.png'),
    fullPage: true,
  });
} finally {
  await browser.close();
}

const errors = consoleLogs.filter(l => l.type === 'error' || l.type === 'pageerror');
console.log('\n=== CONSOLE ERRORS ===');
console.log(errors.length ? errors.map(e => e.text).join('\n') : '(none)');
