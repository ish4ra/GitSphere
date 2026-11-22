#!/usr/bin/env node
// Regenerates GitSphere brand assets in assets/brand/.
//
// Text is converted to vector outlines (Inter, SIL Open Font License) so the
// SVGs render identically everywhere, including GitHub's image proxy. This
// script needs two development-only packages that are intentionally not
// project dependencies:
//
//   npm install --no-save opentype.js@1.3.4 @fontsource/inter@5.1.0
//   node scripts/brand/build-brand.mjs [node_modules directory]
//   node scripts/brand/render-png.mjs    # PNG exports (uses Playwright)

import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const modules = path.resolve(process.argv[2] || path.join(root, 'node_modules'));
const require = createRequire(path.join(modules, 'noop.js'));
const opentype = require('opentype.js');
const fontFile = (weight) => path.join(modules, '@fontsource/inter/files', `inter-latin-${weight}-normal.woff`);
const fonts = Object.fromEntries([400, 500, 600, 700, 800].map((weight) => [weight, opentype.loadSync(fontFile(weight))]));
const out = path.join(root, 'assets', 'brand');

export const PALETTE = {
  night: '#080D19',
  ink: '#0B1220',
  panel: '#0E1628',
  line: '#1E2A44',
  blue: '#6395FF',
  blueLight: '#8CB0FF',
  cyan: '#38CFFF',
  snow: '#F1F5F9',
  mist: '#94A3B8',
  slate: '#475569',
  paper: '#F8FAFC',
  border: '#E2E8F0',
};

// ---- text to outlines ----------------------------------------------------

function textPath(text, { weight = 700, size, x = 0, y = 0, tracking = 0, anchor = 'start' }) {
  const font = fonts[weight];
  const scale = size / font.unitsPerEm;
  const glyphs = font.stringToGlyphs(text);
  let width = 0;
  glyphs.forEach((glyph, index) => {
    width += glyph.advanceWidth * scale + (index < glyphs.length - 1 ? tracking * size : 0);
    if (index < glyphs.length - 1) width += font.getKerningValue(glyph, glyphs[index + 1]) * scale;
  });
  let cursor = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
  const parts = [];
  glyphs.forEach((glyph, index) => {
    parts.push(glyph.getPath(cursor, y, size).toPathData(2));
    cursor += glyph.advanceWidth * scale + tracking * size;
    if (index < glyphs.length - 1) cursor += font.getKerningValue(glyph, glyphs[index + 1]) * scale;
  });
  return { d: parts.join(''), width };
}

// ---- the mark ------------------------------------------------------------

function orbitPoint(theta, { cx, cy, rx, ry, rotation }) {
  const r = (rotation * Math.PI) / 180;
  const x = rx * Math.cos(theta);
  const y = ry * Math.sin(theta);
  return [cx + x * Math.cos(r) - y * Math.sin(r), cy + x * Math.sin(r) + y * Math.cos(r)];
}

/**
 * GitSphere mark: a sphere with meridian/latitude lines, crossed by an
 * inclined orbit that passes behind and in front of it, carrying one
 * satellite node — a developer in the global network.
 */
function mark({ id = 'gs', size = 128, x = 0, y = 0 } = {}) {
  const s = size / 128;
  const orbit = { cx: 64, cy: 64, rx: 60, ry: 19, rotation: -24 };
  const left = orbitPoint(Math.PI, orbit).map((v) => v.toFixed(2));
  const right = orbitPoint(0, orbit).map((v) => v.toFixed(2));
  const satellite = orbitPoint(0.62, orbit).map((v) => v.toFixed(2));
  const arc = (sweep) => `M${left[0]} ${left[1]}A${orbit.rx} ${orbit.ry} ${orbit.rotation} 0 ${sweep} ${right[0]} ${right[1]}`;
  return `
  <g transform="translate(${x} ${y}) scale(${s})">
    <defs>
      <linearGradient id="${id}-sphere" x1="30" y1="24" x2="100" y2="106" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="${PALETTE.blueLight}"/>
        <stop offset="0.5" stop-color="${PALETTE.blue}"/>
        <stop offset="1" stop-color="${PALETTE.cyan}"/>
      </linearGradient>
      <linearGradient id="${id}-orbit" x1="4" y1="90" x2="124" y2="38" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="${PALETTE.cyan}"/>
        <stop offset="1" stop-color="${PALETTE.blue}"/>
      </linearGradient>
      <radialGradient id="${id}-shine" cx="48" cy="44" r="40" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.38"/>
        <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
      </radialGradient>
      <clipPath id="${id}-clip"><circle cx="64" cy="64" r="38"/></clipPath>
    </defs>
    <path d="${arc(1)}" fill="none" stroke="url(#${id}-orbit)" stroke-width="5" stroke-linecap="round" opacity="0.5"/>
    <circle cx="64" cy="64" r="38" fill="url(#${id}-sphere)"/>
    <circle cx="64" cy="64" r="38" fill="url(#${id}-shine)"/>
    <g clip-path="url(#${id}-clip)" fill="none" stroke="#FFFFFF" stroke-opacity="0.34" stroke-width="2.6">
      <ellipse cx="64" cy="64" rx="15" ry="38"/>
      <path d="M26 52C46 60 82 60 102 52"/>
      <path d="M26 76C46 84 82 84 102 76"/>
    </g>
    <path d="${arc(0)}" fill="none" stroke="url(#${id}-orbit)" stroke-width="5" stroke-linecap="round"/>
    <circle cx="${satellite[0]}" cy="${satellite[1]}" r="7.5" fill="${PALETTE.snow}" stroke="${PALETTE.cyan}" stroke-width="3.2"/>
  </g>`;
}

function svg(width, height, body, { title, description } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"${title ? ` aria-labelledby="t"` : ''}>
${title ? `  <title id="t">${title}</title>\n` : ''}${description ? `  <desc>${description}</desc>\n` : ''}${body}
</svg>
`;
}

function wordmark({ x, baseline, size, color, accent = true, id }) {
  const git = textPath('Git', { weight: 700, size, x, y: baseline, tracking: -0.025 });
  const sphere = textPath('Sphere', { weight: 700, size, x: x + git.width + size * 0.005, y: baseline, tracking: -0.025 });
  const gradient = accent
    ? `<defs><linearGradient id="${id}-word" x1="${x + git.width}" y1="0" x2="${x + git.width + sphere.width}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${PALETTE.blue}"/><stop offset="1" stop-color="${PALETTE.cyan}"/></linearGradient></defs>`
    : '';
  return {
    width: git.width + sphere.width,
    body: `${gradient}<path d="${git.d}" fill="${color}"/><path d="${sphere.d}" fill="${accent ? `url(#${id}-word)` : color}"/>`,
  };
}

// ---- globe wireframe for banners ------------------------------------------

function wireframe({ cx, cy, r, color, opacity }) {
  const lines = [`<circle cx="${cx}" cy="${cy}" r="${r}"/>`];
  for (const k of [0.35, 0.7, 0.92]) lines.push(`<ellipse cx="${cx}" cy="${cy}" rx="${(r * k).toFixed(1)}" ry="${r}"/>`);
  for (const t of [-0.6, -0.3, 0, 0.3, 0.6]) {
    const yy = cy + r * t;
    const half = r * Math.sqrt(1 - t * t);
    lines.push(`<ellipse cx="${cx}" cy="${yy.toFixed(1)}" rx="${half.toFixed(1)}" ry="${(half * 0.16).toFixed(1)}"/>`);
  }
  return `<g fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="1.4">${lines.join('')}</g>`;
}

function network({ points, color, opacity }) {
  const edges = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const [a, b] = [points[i], points[j]];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 150) edges.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`);
    }
  }
  return `<g stroke="${color}" stroke-opacity="${opacity}" stroke-width="1.2">${edges.join('')}</g>
  <g fill="${color}">${points.map(([px, py, rr = 3]) => `<circle cx="${px}" cy="${py}" r="${rr}" fill-opacity="${Math.min(1, opacity * 4)}"/>`).join('')}</g>`;
}

const NODES = [[860, 92], [948, 64, 4], [1032, 118], [1120, 76, 3.5], [1196, 150], [904, 196, 4], [1004, 232], [1092, 214, 4.5], [1180, 268], [950, 300], [1060, 300, 3.5], [1230, 60]];

function banner(theme) {
  const dark = theme === 'dark';
  const W = 1280;
  const H = 360;
  const fg = dark ? PALETTE.snow : PALETTE.ink;
  const muted = dark ? PALETTE.mist : PALETTE.slate;
  const word = wordmark({ x: 228, baseline: 196, size: 92, color: fg, id: `banner-${theme}` });
  const tagline = textPath('Discover the global GitHub ecosystem.', { weight: 500, size: 30, x: 232, y: 250, tracking: -0.01 });
  const sub = textPath('Repositories · Developers · Contributors — 250 countries and territories', { weight: 400, size: 19, x: 233, y: 290 });
  const background = dark
    ? `<rect width="${W}" height="${H}" rx="24" fill="${PALETTE.night}"/>
  <radialGradient id="bg-${theme}" cx="1010" cy="180" r="520" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1A2D5C" stop-opacity="0.9"/><stop offset="1" stop-color="${PALETTE.night}" stop-opacity="0"/></radialGradient>
  <rect width="${W}" height="${H}" rx="24" fill="url(#bg-${theme})"/>`
    : `<linearGradient id="bg-${theme}" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#EAF1FF"/></linearGradient>
  <rect width="${W}" height="${H}" rx="24" fill="url(#bg-${theme})"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="23.5" fill="none" stroke="${PALETTE.border}"/>`;
  return svg(W, H, `  ${background}
  ${wireframe({ cx: 1030, cy: 180, r: 230, color: PALETTE.blue, opacity: dark ? 0.16 : 0.2 })}
  ${network({ points: NODES, color: PALETTE.cyan, opacity: dark ? 0.22 : 0.3 })}
  ${mark({ id: `bm-${theme}`, size: 136, x: 72, y: 112 })}
  ${word.body}
  <path d="${tagline.d}" fill="${fg}" fill-opacity="${dark ? 0.92 : 0.88}"/>
  <path d="${sub.d}" fill="${muted}"/>`, { title: 'GitSphere — Discover the global GitHub ecosystem.' });
}

function logo(theme) {
  const fg = theme === 'dark' ? PALETTE.snow : PALETTE.ink;
  const word = wordmark({ x: 150, baseline: 88, size: 72, color: fg, id: `logo-${theme}` });
  const width = Math.ceil(150 + word.width + 8);
  return svg(width, 128, `  ${mark({ id: `lm-${theme}`, size: 128 })}\n  ${word.body}`, { title: 'GitSphere' });
}

const ICONS = {
  repositories: `<path d="M28 13.5l4.2 8.6 9.5 1.4-6.9 6.7 1.6 9.4L28 35.2l-8.4 4.4 1.6-9.4-6.9-6.7 9.5-1.4z" fill="none" stroke="#FFFFFF" stroke-width="2.6" stroke-linejoin="round"/>`,
  developers: `<circle cx="28" cy="21" r="6.5" fill="none" stroke="#FFFFFF" stroke-width="2.6"/><path d="M16.5 40c1.6-6.6 6.2-10 11.5-10s9.9 3.4 11.5 10" fill="none" stroke="#FFFFFF" stroke-width="2.6" stroke-linecap="round"/><circle cx="40.5" cy="15" r="3" fill="#FFFFFF"/>`,
  contributors: [0, 1, 2, 3].flatMap((col) => [0, 1, 2].map((row) => {
    const levels = [[0.35, 0.7, 1], [0.6, 1, 0.45], [1, 0.5, 0.8], [0.45, 0.9, 1]];
    return `<rect x="${13.5 + col * 7.6}" y="${15 + row * 7.6}" width="5.6" height="5.6" rx="1.4" fill="#FFFFFF" fill-opacity="${levels[col][row]}"/>`;
  })).join(''),
};

const CARD_TEXT = {
  repositories: ['Top Repositories', 'Discover the most-starred GitHub', 'repositories by country.'],
  developers: ['Top Developers', 'Discover GitHub users ranked', 'by followers.'],
  contributors: ['Top Contributors', 'Discover GitHub users ranked by', 'public contribution activity.'],
};

function card(mode, theme) {
  const dark = theme === 'dark';
  const W = 420;
  const H = 232;
  const [title, line1, line2] = CARD_TEXT[mode];
  const fg = dark ? PALETTE.snow : PALETTE.ink;
  const muted = dark ? PALETTE.mist : PALETTE.slate;
  const t = textPath(title, { weight: 700, size: 27, x: 32, y: 134, tracking: -0.015 });
  const d1 = textPath(line1, { weight: 400, size: 17.5, x: 32, y: 166 });
  const d2 = textPath(line2, { weight: 400, size: 17.5, x: 32, y: 190 });
  const id = `card-${mode}-${theme}`;
  return svg(W, H, `  <defs>
    <linearGradient id="${id}-tile" x1="0" y1="0" x2="56" y2="56" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${PALETTE.blue}"/><stop offset="1" stop-color="${PALETTE.cyan}"/></linearGradient>
    <radialGradient id="${id}-glow" cx="370" cy="40" r="220" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${PALETTE.blue}" stop-opacity="${dark ? 0.22 : 0.12}"/><stop offset="1" stop-color="${PALETTE.blue}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="20" fill="${dark ? PALETTE.panel : '#FFFFFF'}" stroke="${dark ? PALETTE.line : PALETTE.border}" stroke-width="1.5"/>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="20" fill="url(#${id}-glow)"/>
  <g transform="translate(32 32)"><rect width="56" height="56" rx="15" fill="url(#${id}-tile)"/>${ICONS[mode]}</g>
  <path d="M364 60h22M378 52l8 8-8 8" fill="none" stroke="${dark ? PALETTE.mist : PALETTE.slate}" stroke-opacity="0.7" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="${t.d}" fill="${fg}"/>
  <path d="${d1.d}" fill="${muted}"/>
  <path d="${d2.d}" fill="${muted}"/>`, { title: `${title} — ${line1} ${line2}` });
}

function icon(mode) {
  return svg(56, 56, `  <defs><linearGradient id="i-${mode}" x1="0" y1="0" x2="56" y2="56" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${PALETTE.blue}"/><stop offset="1" stop-color="${PALETTE.cyan}"/></linearGradient></defs>
  <rect width="56" height="56" rx="15" fill="url(#i-${mode})"/>${ICONS[mode]}`, { title: CARD_TEXT[mode][0] });
}

function socialPreview() {
  const W = 1280;
  const H = 640;
  const word = wordmark({ x: 0, baseline: 0, size: 116, color: PALETTE.snow, id: 'social' });
  const markSize = 168;
  const gap = 28;
  const total = markSize + gap + word.width;
  const left = (W - total) / 2;
  const wordAt = wordmark({ x: left + markSize + gap, baseline: 318, size: 116, color: PALETTE.snow, id: 'social' });
  const tagline = textPath('Discover the global GitHub ecosystem.', { weight: 500, size: 40, x: W / 2, y: 412, anchor: 'middle', tracking: -0.01 });
  const chips = ['Top Repositories', 'Top Developers', 'Top Contributors'];
  const chipText = chips.map((label) => textPath(label, { weight: 600, size: 24 }));
  const chipWidths = chipText.map((item) => item.width + 48);
  const chipsTotal = chipWidths.reduce((a, b) => a + b, 0) + 20 * (chips.length - 1);
  let chipX = (W - chipsTotal) / 2;
  const chipSvg = chips.map((label, index) => {
    const widthNow = chipWidths[index];
    const text = textPath(label, { weight: 600, size: 24, x: chipX + 24, y: 505 });
    const markup = `<rect x="${chipX.toFixed(1)}" y="472" width="${widthNow.toFixed(1)}" height="48" rx="24" fill="#111C33" stroke="#24345A"/><path d="${text.d}" fill="${PALETTE.snow}" fill-opacity="0.92"/>`;
    chipX += widthNow + 20;
    return markup;
  }).join('');
  const foot = textPath('250 countries and territories  ·  open source  ·  github.com/ish4ra/GitSphere', { weight: 400, size: 20, x: W / 2, y: 588, anchor: 'middle' });
  void word;
  return svg(W, H, `  <rect width="${W}" height="${H}" fill="${PALETTE.night}"/>
  <radialGradient id="social-bg" cx="640" cy="250" r="640" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1A2D5C"/><stop offset="1" stop-color="${PALETTE.night}" stop-opacity="0"/></radialGradient>
  <rect width="${W}" height="${H}" fill="url(#social-bg)"/>
  ${wireframe({ cx: 640, cy: 300, r: 420, color: PALETTE.blue, opacity: 0.09 })}
  ${mark({ id: 'sm', size: markSize, x: left, y: 196 })}
  ${wordAt.body}
  <path d="${tagline.d}" fill="${PALETTE.snow}" fill-opacity="0.9"/>
  ${chipSvg}
  <path d="${foot.d}" fill="${PALETTE.mist}"/>`, { title: 'GitSphere — Discover the global GitHub ecosystem.' });
}

await mkdir(out, { recursive: true });
const files = {
  'gitsphere-mark.svg': svg(128, 128, mark({ id: 'm' }), { title: 'GitSphere' }),
  'gitsphere-logo-light.svg': logo('light'),
  'gitsphere-logo-dark.svg': logo('dark'),
  'banner-light.svg': banner('light'),
  'banner-dark.svg': banner('dark'),
  'social-preview.svg': socialPreview(),
};
for (const mode of Object.keys(CARD_TEXT)) {
  files[`card-${mode}-light.svg`] = card(mode, 'light');
  files[`card-${mode}-dark.svg`] = card(mode, 'dark');
  files[`icon-${mode}.svg`] = icon(mode);
}
for (const [name, content] of Object.entries(files)) await writeFile(path.join(out, name), content, 'utf8');
console.log(`Wrote ${Object.keys(files).length} brand assets to ${path.relative(root, out)}/`);
