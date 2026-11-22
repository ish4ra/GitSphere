import test from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRIES, countryCodeToFlag, getCountry, slugify } from '../src/countries.js';

test('global catalog contains 249 ISO 3166-1 entries plus Kosovo', () => {
  assert.equal(COUNTRIES.length, 250);
  assert.equal(new Set(COUNTRIES.map((country) => country.code)).size, 250);
  assert.equal(new Set(COUNTRIES.map((country) => country.slug)).size, 250);
  assert.equal(getCountry('XK')?.name, 'Kosovo');
  assert.ok(getCountry('AX'));
});

test('public ranking slugs are stable for existing URLs', () => {
  assert.equal(getCountry('LK').slug, 'sri-lanka');
  assert.equal(getCountry('US').slug, 'united-states');
  assert.equal(getCountry('GB').slug, 'united-kingdom');
  assert.equal(getCountry('CI').slug, 'cote-d-ivoire');
  assert.equal(slugify('Åland Islands'), 'aland-islands');
});

test('special administrative regions keep concise names and aliases', () => {
  assert.equal(getCountry('HK')?.name, 'Hong Kong');
  assert.ok(getCountry('HK')?.aliases.includes('Hong Kong SAR'));
  assert.ok(getCountry('MO')?.aliases.includes('Macau'));
  assert.ok(getCountry('LK')?.aliases.includes('Srilanka'));
  assert.equal(countryCodeToFlag('LK'), '🇱🇰');
});
