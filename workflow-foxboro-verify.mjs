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

  await page.screenshot({
    path: resolve('/Users/manish/gpxexport', 'screenshot-foxboro-3d.png'),
    fullPage: true,
  });
} finally {
  await browser.close();
}

const errors = consoleLogs.filter(l => l.type === 'error' || l.type === 'pageerror');
console.log('\n=== CONSOLE ERRORS ===');
console.log(errors.length ? errors.map(e => e.text).join('\n') : '(none)');
