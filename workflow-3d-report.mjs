import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const baseDir = '/Users/manish/gpxexport';
const gpxBuffer = readFileSync(resolve(baseDir, 'sample.gpx'));

const consoleLogs = [];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage();
page.setViewportSize({ width: 1280, height: 900 });

page.on('console', (msg) => {
  consoleLogs.push({ type: msg.type(), text: msg.text() });
});
page.on('pageerror', (err) => {
  consoleLogs.push({ type: 'pageerror', text: err.message });
});

try {
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1000);

  await page.locator('#file-input').setInputFiles({
    name: 'sample.gpx',
    mimeType: 'application/gpx+xml',
    buffer: gpxBuffer,
  });

  await page.waitForFunction(
    () => document.getElementById('empty-state')?.classList.contains('hidden'),
    { timeout: 10000 }
  );
  await page.waitForTimeout(2500);

  await page.click('button[data-view="3d"]');

  await page.waitForTimeout(25000);

  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden'),
    { timeout: 5000 }
  ).catch(() => {});
  await page.waitForTimeout(1500);

  await page.screenshot({
    path: resolve(baseDir, 'screenshot-3d-report.png'),
    fullPage: true,
  });
} finally {
  await browser.close();
}

console.log('\n=== CONSOLE OUTPUT (errors & warnings) ===');
const errWarn = consoleLogs.filter(l => l.type === 'error' || l.type === 'warning' || l.type === 'pageerror');
console.log(errWarn.length ? errWarn.map(l => `[${l.type}] ${l.text}`).join('\n') : '(none)');

console.log('\n=== ALL CONSOLE MESSAGES ===');
consoleLogs.forEach(l => console.log(`[${l.type}] ${l.text}`));
