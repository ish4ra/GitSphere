import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNTRIES } from '../src/countries.js';
import { LEGACY_SLUGS } from '../src/publish/publish.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function markdownFiles(directory) {
  const out = [];
  for (const entry of readdirSync(path.join(root, directory))) {
    const relative = path.join(directory, entry);
    if (statSync(path.join(root, relative)).isDirectory()) out.push(...markdownFiles(relative));
    else if (entry.endsWith('.md')) out.push(relative);
  }
  return out;
}

const files = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', ...markdownFiles('docs'), ...markdownFiles('rankings'), 'assets/brand/README.md', 'geography/README.md'];

test('every relative link and image in published Markdown resolves', () => {
  const broken = [];
  let checked = 0;
  for (const file of files) {
    const text = readFileSync(path.join(root, file), 'utf8');
    const targets = [
      ...[...text.matchAll(/(?:href|src|srcset)="([^"]+)"/g)].map((match) => match[1]),
      ...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]),
    ];
    for (const target of targets) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const clean = decodeURIComponent(target.split('#')[0]);
      if (!clean) continue;
      checked += 1;
      if (!existsSync(path.resolve(root, path.dirname(file), clean))) broken.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(broken.slice(0, 10), []);
  assert.ok(checked > 3000, `checked ${checked} links`);
});

test('the README exposes the three entry points and their directories', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  for (const directory of ['rankings/README.md', 'rankings/developers/README.md', 'rankings/contributors/README.md']) {
    assert.ok(readme.includes(`href="./${directory}"`), directory);
    const listing = readFileSync(path.join(root, directory), 'utf8');
    assert.equal((listing.match(/\]\(\.\/[a-z0-9-]+\.md\)/g) || []).length, COUNTRIES.length, `${directory} lists every country`);
  }
  for (const asset of ['banner-light.svg', 'banner-dark.svg', 'card-repositories-light.svg', 'card-developers-dark.svg', 'card-contributors-light.svg', 'gitsphere-mark.svg', 'gitsphere-mark.png', 'social-preview.png']) {
    assert.ok(existsSync(path.join(root, 'assets/brand', asset)), asset);
  }
  const png = readFileSync(path.join(root, 'assets/brand/social-preview.png'));
  assert.equal(png.readUInt32BE(16), 1280);
  assert.equal(png.readUInt32BE(20), 640);
  assert.ok(png.length < 1024 * 1024, 'social preview under 1 MB');
});

test('pre-GitSphere ranking URLs keep working', () => {
  for (const country of COUNTRIES) {
    assert.ok(existsSync(path.join(root, 'rankings', `${country.slug}.md`)), country.slug);
    const data = JSON.parse(readFileSync(path.join(root, 'data', `${country.code}.json`), 'utf8'));
    assert.ok(Array.isArray(data.repositories) && data.country.slug === country.slug, country.code);
    for (const entry of data.repositories.slice(0, 1)) {
      for (const field of ['rank', 'name', 'nameWithOwner', 'url', 'stars', 'forks', 'owner']) assert.ok(field in entry, `${country.code}.${field}`);
    }
  }
  for (const [slug, code] of LEGACY_SLUGS) {
    const page = readFileSync(path.join(root, 'rankings', `${slug}.md`), 'utf8');
    assert.ok(page.includes(COUNTRIES.find((country) => country.code === code).slug));
  }
});

test('committed data never claims a refresh that did not happen', () => {
  const summary = JSON.parse(readFileSync(path.join(root, 'data/summary.json'), 'utf8'));
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  if (!summary.lastRun || summary.lastRun.requests === 0) {
    assert.equal(summary.lastSuccessfulRefresh ?? null, null);
    assert.ok(readme.includes('Awaiting first live refresh'));
    assert.ok(!readme.includes('Last successful refresh'));
  }
});
