import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const baseDir = '/Users/manish/gpxexport';
const samplePath = resolve(baseDir, 'sample.gpx');
const sampleBuffer = readFileSync(samplePath);

const consoleLogs = [];

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
});

try {
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1000);

  // Run Terrarium tile test in page context
  await page.evaluate(async () => {
    async function testTile() {
      try {
        const url = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/10/512/512.png';
        const resp = await fetch(url);
        console.log('FETCH_STATUS:', resp.status, resp.ok);
        const blob = await resp.blob();
        console.log('BLOB_SIZE:', blob.size);
        const bitmap = await createImageBitmap(blob);
        console.log('BITMAP:', bitmap.width, bitmap.height);
        const cvs = document.createElement('canvas');
        cvs.width = 256;
        cvs.height = 256;
        const ctx = cvs.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const imgData = ctx.getImageData(0, 0, 256, 256);
        const r = imgData.data[0], g = imgData.data[1], b = imgData.data[2];
        const elev = (r * 256 + g + b / 256) - 32768;
        console.log('ELEVATION_SAMPLE:', elev);
        console.log('TEST_PASSED');
      } catch (e) {
        console.log('TEST_FAILED:', e.message);
      }
    }
    await testTile();
  });

  await page.waitForTimeout(500);

  // Upload sample.gpx
  await page.locator('#file-input').setInputFiles({
    name: 'sample.gpx',
    mimeType: 'application/gpx+xml',
    buffer: sampleBuffer,
  });

  await page.waitForFunction(
    () => document.getElementById('empty-state')?.classList.contains('hidden'),
    { timeout: 8000 }
  );

  // Click 3D tab
  await page.click('button[data-view="3d"]');

  // Wait 20 seconds for terrain
  await page.waitForTimeout(20000);

  // Take screenshot
  await page.screenshot({ path: resolve(baseDir, 'screenshot-terrarium-test.png'), fullPage: true });
} finally {
  await browser.close();
}

// Report ALL console output
console.log('\n=== ALL CONSOLE OUTPUT ===\n');
consoleLogs.forEach(({ type, text }) => {
  console.log(`[${type}] ${text}`);
});

console.log('\n=== KEY LINES (FETCH_, BLOB_, BITMAP_, ELEVATION_, TEST_, [terrain]) ===\n');
consoleLogs.forEach(({ text }) => {
  if (
    text.startsWith('FETCH_') ||
    text.startsWith('BLOB_') ||
    text.startsWith('BITMAP_') ||
    text.startsWith('ELEVATION_') ||
    text.startsWith('TEST_') ||
    text.includes('[terrain]') ||
    text.toLowerCase().includes('terrain')
  ) {
    console.log(text);
  }
});
