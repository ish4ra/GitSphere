#!/usr/bin/env node
// Rasterizes brand SVGs to PNG with Playwright/Chromium:
//   assets/brand/gitsphere-mark.png   512×512, transparent
//   assets/brand/gitsphere-logo-*.png transparent, 2× density
//   assets/brand/social-preview.png   1280×640 (GitHub social preview)
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Playwright is resolved from the environment (CommonJS global path).
const { chromium } = createRequire(import.meta.url)('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const brand = path.join(root, 'assets', 'brand');
const browser = await chromium.launch();

async function render(svgName, pngName, { width, height, scale = 1, transparent = true }) {
  const svg = await readFile(path.join(brand, svgName), 'utf8');
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg.replace(/<svg ([^>]*?)width="[^"]+" height="[^"]+"/, `<svg $1width="${width}" height="${height}"`)}</body></html>`);
  await page.screenshot({ path: path.join(brand, pngName), omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
  await page.close();
  const { size } = await stat(path.join(brand, pngName));
  console.log(`${pngName}: ${width * scale}×${height * scale}, ${(size / 1024).toFixed(0)} KB`);
}

const logoWidth = Number((await readFile(path.join(brand, 'gitsphere-logo-light.svg'), 'utf8')).match(/width="(\d+)"/)[1]);
await render('gitsphere-mark.svg', 'gitsphere-mark.png', { width: 512, height: 512 });
await render('gitsphere-logo-light.svg', 'gitsphere-logo-light.png', { width: logoWidth, height: 128, scale: 2 });
await render('gitsphere-logo-dark.svg', 'gitsphere-logo-dark.png', { width: logoWidth, height: 128, scale: 2 });
await render('social-preview.svg', 'social-preview.png', { width: 1280, height: 640, transparent: false });
await browser.close();
