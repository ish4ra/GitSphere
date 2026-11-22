import test from 'node:test';
import assert from 'node:assert/strict';
import { createGlobalLocationResolver } from '../src/geo/resolver.js';
import { COUNTRIES } from '../src/countries.js';
import { buildGazetteers } from '../src/geo/gazetteer-build.js';
import { foldTransliteration, normalizeLocation } from '../src/geo/normalize.js';

// A synthetic, fully controlled gazetteer: exercises the real resolver and
// the real builder without depending on upstream data drift.
const csc = [
  country('US', 'USA', 331_000_000, [
    state('OR', 'Oregon', ['Portland', 'Salem']),
    state('ME', 'Maine', ['Portland']),
    state('CA', 'California', ['San Francisco', 'Ontario']),
    state('GA', 'Georgia', ['Atlanta']),
    state('WA', 'Washington', ['Redmond', 'Seattle']),
  ]),
  country('AU', 'AUS', 25_000_000, [state('VIC', 'Victoria', ['Portland', 'Melbourne'])]),
  country('CA', 'CAN', 38_000_000, [state('ON', 'Ontario', ['Toronto', 'London'])]),
  country('GB', 'GBR', 67_000_000, [state('ENG', 'England', ['London'])]),
  country('GE', 'GEO', 3_700_000, [state('TB', 'Tbilisi', ['Tbilisi'])]),
  country('BR', 'BRA', 213_000_000, [state('PR', 'Paraná', ['Colombo', 'Curitiba'])]),
  country('LK', 'LKA', 21_000_000, [state('1', 'Western', ['Colombo', 'Kalutara South', 'Matugama'])]),
  country('CN', 'CHN', 1_400_000_000, [state('HK', 'Hong Kong SAR', ['Kowloon']), state('BJ', 'Beijing', ['Beijing'])]),
  country('HK', 'HKG', 7_400_000, []),
  country('MX', 'MEX', 126_000_000, [state('NLE', 'Nuevo León', ['China'])]),
];
const cities500 = [
  geo(1, 'Portland', 'US', 'OR', 650_000),
  geo(2, 'Portland', 'US', 'ME', 68_000),
  geo(3, 'Portland', 'AU', '01', 10_000),
  geo(4, 'London', 'GB', 'ENG', 8_900_000),
  geo(5, 'London', 'CA', '08', 400_000),
  geo(6, 'Colombo', 'LK', '36', 650_000),
  geo(7, 'Colombo', 'BR', '18', 240_000),
  geo(8, 'China', 'MX', '19', 10_000),
].join('\n');
const admin1 = ['US.OR\tOregon\tOregon\t1', 'US.ME\tMaine\tMaine\t2', 'AU.01\tVictoria\tVictoria\t3',
  'GB.ENG\tEngland\tEngland\t4', 'CA.08\tOntario\tOntario\t5', 'LK.36\tWestern Province\tWestern Province\t6',
  'BR.18\tParana\tParana\t7', 'MX.19\tNuevo Leon\tNuevo Leon\t8'].join('\n');

const gazetteers = [...buildGazetteers({ csc, catalog: COUNTRIES, cities500, admin1 }).values()];
const resolver = createGlobalLocationResolver({ countries: COUNTRIES, gazetteers });
const code = (value) => resolver.resolve(value).countryCode;

test('compound city + subdivision code resolves contextually', () => {
  assert.equal(code('Portland, OR'), 'US');
  assert.equal(code('San Francisco, CA'), 'US');
  assert.equal(code('Redmond, WA'), 'US');
  assert.equal(code('Atlanta, GA'), 'US');
  assert.equal(code('London, ON'), 'CA');
  assert.equal(resolver.resolve('Portland, OR').evidence, 'place-with-subdivision');
});

test('ambiguous names stay ambiguous without context', () => {
  for (const value of ['Portland', 'Georgia', 'Colombo']) {
    const result = resolver.resolve(value);
    assert.equal(result.accepted, false, value);
    assert.equal(result.confidence, 'ambiguous', value);
  }
});

test('a dominant major place resolves; explicit countries beat village homonyms', () => {
  assert.equal(code('London'), 'GB');
  assert.equal(resolver.resolve('London').evidence, 'dominant-place');
  assert.equal(code('China'), 'CN');
  assert.equal(code('USA'), 'US');
});

test('explicit country context disambiguates places', () => {
  assert.equal(code('Colombo, Sri Lanka'), 'LK');
  assert.equal(code('Colombo-PR, Brazil'), 'BR');
  assert.equal(code('Colombo-PR'), 'BR');
  assert.equal(code('Kalutara South, Srilanka'), 'LK');
  assert.equal(code('Tbilisi, Georgia'), 'GE');
  assert.equal(code('Atlanta, Georgia'), 'US');
});

test('conflicting countries are never forced into one', () => {
  const result = resolver.resolve('Sri Lanka / Brazil');
  assert.equal(result.accepted, false);
  assert.equal(result.evidence, 'multiple-countries');
  assert.deepEqual(result.conflicts, ['BR', 'LK']);
});

test('catalog territories win over a parent duplicate subdivision', () => {
  assert.equal(code('Hong Kong SAR'), 'HK');
  assert.equal(code('Kowloon'), 'HK');
  assert.equal(code('Beijing'), 'CN');
});

test('non-geographic, supranational and empty locations are unknown', () => {
  for (const [value, evidence] of [
    ['', 'missing-location'],
    ['   ', 'missing-location'],
    ['Earth', 'non-geographic-location'],
    ['Remote', 'non-geographic-location'],
    ['Middle-earth', 'non-geographic-location'],
    ['localhost', 'non-geographic-location'],
    ['Europe', 'supranational-region'],
    ['Qwertyville', 'unrecognized-location'],
  ]) {
    const result = resolver.resolve(value);
    assert.equal(result.accepted, false, value);
    assert.equal(result.evidence, evidence, value);
  }
  assert.equal(code('Remote, Brazil'), 'BR');
});

test('bare codes are accepted only when they cannot be a subdivision code', () => {
  assert.equal(resolver.resolve('CA').accepted, false);
  assert.equal(code('GE'), 'GE');
  assert.equal(code('🇱🇰'), 'LK');
});

test('South Asian transliteration variants resolve via folding', () => {
  assert.equal(foldTransliteration(normalizeLocation('Mathugama')), foldTransliteration('matugama'));
  assert.equal(code('Mathugama'), 'LK');
  assert.equal(resolver.resolve('Mathugama').evidence, 'transliterated-place');
});

test('normalization is Unicode-safe', () => {
  assert.equal(normalizeLocation('  São  Paulo '), 'sao paulo');
  assert.equal(normalizeLocation('München'), 'munchen');
  assert.equal(normalizeLocation('Kraków'), 'krakow');
  assert.equal(normalizeLocation('කොළඹ'), 'කොළඹ'.normalize('NFC'));
});

function country(iso2, iso3, population, states) {
  return { iso2, iso3, name: COUNTRIES.find((item) => item.code === iso2).name, population, translations: {}, states };
}
function state(iso2, name, cities) {
  return { iso2, name, type: 'state', cities: cities.map((city) => ({ name: city })) };
}
function geo(id, name, countryCode, admin, population) {
  return [id, name, name, '', 0, 0, 'P', 'PPL', countryCode, '', admin, '', '', '', population, '', '', '', ''].join('\t');
}
