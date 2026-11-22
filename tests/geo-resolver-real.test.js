import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSharedResolver } from '../src/geo/resolver.js';

// Integration tests against the committed gazetteer. Population-dependent
// expectations require the complete CSC + GeoNames build.
let manifest = { complete: false };
try {
  manifest = JSON.parse(readFileSync(new URL('../geography/manifest.json', import.meta.url), 'utf8'));
} catch {
  // Legacy geography format: the whole suite is skipped below.
}
const ready = manifest.schemaVersion === 2;
const complete = ready && manifest.complete === true;

const CASES = [
  ['Portland, OR', 'US'],
  ['San Francisco, CA', 'US'],
  ['Redmond, WA', 'US'],
  ['Hong Kong SAR', 'HK'],
  ['Kalutara South, Srilanka', 'LK'],
  ['Colombo, Sri Lanka', 'LK'],
  ['Colombo-PR, Brazil', 'BR'],
  ['Atlanta, Georgia', 'US'],
  ['Tbilisi, Georgia', 'GE'],
  ['Berlin, Germany', 'DE'],
  ['London, UK', 'GB'],
  ['Seoul, Korea', 'KR'],
  ['China', 'CN'],
  ['USA', 'US'],
  ['Taipei, Taiwan', 'TW'],
  ['San Juan, Puerto Rico', 'PR'],
  ['🇯🇵', 'JP'],
];

const POPULATION_CASES = [
  ['Mathugama', 'LK'],
  ['London', 'GB'],
  ['Paris', 'FR'],
  ['Tokyo', 'JP'],
  ['Bangalore', 'IN'],
  ['Bengaluru, India', 'IN'],
  ['München', 'DE'],
  ['Toronto, CA', 'CA'],
  ['Helsinki', 'FI'],
  ['Shenzhen', 'CN'],
];

test('real gazetteer: explicit and compound locations', { skip: !ready }, async () => {
  const resolver = await loadSharedResolver();
  for (const [location, expected] of CASES) {
    assert.equal(resolver.resolve(location).countryCode, expected, location);
  }
});

test('real gazetteer: ambiguous and non-geographic locations are not forced', { skip: !ready }, async () => {
  const resolver = await loadSharedResolver();
  for (const location of ['Georgia', 'Portland', 'Colombo', 'Earth', 'Remote', '', 'Worldwide', 'Europe', 'Cambridge']) {
    const result = resolver.resolve(location);
    assert.equal(result.accepted, false, `${location} -> ${result.countryCode}`);
  }
});

test('real gazetteer: population-weighted places', { skip: !complete }, async () => {
  const resolver = await loadSharedResolver();
  for (const [location, expected] of POPULATION_CASES) {
    assert.equal(resolver.resolve(location).countryCode, expected, location);
  }
});
