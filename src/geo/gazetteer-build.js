// Builds compact, population-aware per-country gazetteers from:
//   * Countries States Cities Database (ODbL-1.0): country translations,
//     administrative subdivisions with ISO 3166-2 codes, cities/towns.
//   * GeoNames cities500 + admin1CodesASCII (CC BY 4.0): populated places
//     with population, feature codes and alternate/native names.
// The output deliberately keeps population and feature class so the shared
// resolver can weigh "London" (8.9M, GB) against "London" (400k, CA).

import { normalizeLocation } from './normalize.js';

export const GAZETTEER_SCHEMA_VERSION = 2;

const ADMIN_SUFFIXES = /\b(province|state|region|district|governorate|prefecture|county|department|oblast|krai|republic|municipality|division|territory|canton|voivodeship|emirate|parish|autonomous|special|administrative|capital|metropolitan|city|of|the)\b/g;
const MAX_TERM_LENGTH = 80;

export function adminMatchKey(value) {
  return normalizeLocation(value).replace(ADMIN_SUFFIXES, ' ').replace(/\s+/g, ' ').trim();
}

export function cleanTerm(value) {
  const term = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!term || term.length > MAX_TERM_LENGTH) return null;
  if (/^https?:|www\.|@|\d{3,}/i.test(term)) return null;
  if (!normalizeLocation(term)) return null;
  return term;
}

/**
 * @param {object} input
 * @param {Array} input.csc        CSC countries+states+cities export
 * @param {Array} input.catalog    GitSphere country catalog (src/countries.js)
 * @param {string|null} input.cities500   GeoNames cities500 TSV text
 * @param {string|null} input.admin1      GeoNames admin1CodesASCII TSV text
 * @returns {Map<string, object>} code -> gazetteer
 */
export function buildGazetteers({ csc, catalog, cities500 = null, admin1 = null }) {
  const byCode = new Map();
  for (const country of catalog) {
    byCode.set(country.code, {
      code: country.code,
      names: new Set([country.name, ...(country.aliases || [])]),
      iso3: null,
      population: 0,
      admins: new Map(), // key -> { code, type, names:Set }
      places: new Map(), // normalizedName|adminKey -> place
      counts: { cscStates: 0, cscCities: 0, geonamesPlaces: 0, geonamesAlternateNames: 0 },
    });
  }

  for (const country of Array.isArray(csc) ? csc : []) {
    const code = String(country?.iso2 || '').toUpperCase();
    const target = byCode.get(code);
    if (!target) continue;
    for (const value of [country.name, country.native, ...Object.values(country.translations || {})]) {
      const term = cleanTerm(value);
      if (term) target.names.add(term);
    }
    target.iso3 = /^[A-Z]{3}$/.test(country.iso3 || '') ? country.iso3 : null;
    target.population = Number(country.population) || 0;

    for (const state of country.states || []) {
      target.counts.cscStates += 1;
      const adminCode = normalizeAdminCode(state.iso2, code);
      const admin = upsertAdmin(target, adminMatchKey(state.name) || normalizeLocation(state.name), {
        code: adminCode,
        type: state.type || null,
      });
      for (const value of [state.name, state.native, ...Object.values(state.translations || {})]) {
        const term = cleanTerm(value);
        if (term) admin.names.add(term);
      }
      for (const city of state.cities || []) {
        target.counts.cscCities += 1;
        const term = cleanTerm(city.name);
        if (!term) continue;
        const place = upsertPlace(target, term, admin.key);
        for (const value of [city.native, ...Object.values(city.translations || {})]) {
          const alt = cleanTerm(value);
          if (alt) place.names.add(alt);
        }
      }
    }
  }

  // GeoNames admin1 crosswalk: "LK.36" -> CSC admin key, matched by name.
  const geonamesAdmin = new Map();
  for (const line of String(admin1 || '').split('\n')) {
    const [id, name, asciiName] = line.split('\t');
    if (!id || !name) continue;
    const [code, adminId] = id.split('.');
    const target = byCode.get(code);
    if (!target) continue;
    const key = adminMatchKey(asciiName || name) || normalizeLocation(name);
    let admin = target.admins.get(key);
    if (!admin) {
      admin = [...target.admins.values()].find(
        (item) => [...item.names].some((alt) => adminMatchKey(alt) === key),
      );
    }
    if (!admin) admin = upsertAdmin(target, key, { code: null, type: 'admin1' });
    admin.names.add(name);
    if (asciiName) admin.names.add(asciiName);
    geonamesAdmin.set(id, admin.key);
  }

  for (const line of String(cities500 || '').split('\n')) {
    const columns = line.split('\t');
    if (columns.length < 15) continue;
    const code = columns[8];
    const target = byCode.get(code);
    if (!target) continue;
    const name = cleanTerm(columns[1]);
    if (!name) continue;
    const population = Number.parseInt(columns[14], 10) || 0;
    const featureCode = columns[7] || null;
    const adminKey = geonamesAdmin.get(`${code}.${columns[10]}`) || null;
    const place = upsertPlace(target, name, adminKey);
    place.population = Math.max(place.population, population);
    place.featureCode = place.featureCode || featureCode;
    place.geonames = true;
    target.counts.geonamesPlaces += 1;
    const ascii = cleanTerm(columns[2]);
    if (ascii) place.names.add(ascii);

    const alternates = columns[3] ? columns[3].split(',') : [];
    const limit = population >= 100000 ? 400 : population >= 10000 ? 60 : 25;
    let kept = 0;
    for (const raw of alternates) {
      if (kept >= limit) break;
      const alt = cleanTerm(raw);
      if (!alt || alt.length < 3) continue;
      // Short all-caps alternates are usually airport/station codes ("CMB",
      // "LHR"); keep them only for very large cities ("NYC").
      if (/^[A-Z0-9]{2,4}$/.test(alt) && population < 1000000) continue;
      place.names.add(alt);
      kept += 1;
    }
    target.counts.geonamesAlternateNames += kept;
  }

  const result = new Map();
  for (const [code, target] of byCode) {
    const admins = [...target.admins.values()]
      .map((admin) => ({ key: admin.key, code: admin.code, type: admin.type, names: sortTerms(admin.names) }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const adminIndex = new Map(admins.map((admin, index) => [admin.key, index]));
    const places = [...target.places.values()]
      .map((place) => [
        place.population,
        place.adminKey != null && adminIndex.has(place.adminKey) ? adminIndex.get(place.adminKey) : -1,
        place.featureCode || '',
        ...sortTerms(place.names, place.name),
      ])
      .sort((a, b) => b[0] - a[0] || String(a[3]).localeCompare(String(b[3])));

    result.set(code, {
      schemaVersion: GAZETTEER_SCHEMA_VERSION,
      country: { code, iso3: target.iso3, population: target.population },
      counts: {
        countryNames: target.names.size,
        admins: admins.length,
        places: places.length,
        placesWithPopulation: places.filter((place) => place[0] > 0).length,
        ...target.counts,
      },
      names: sortTerms(target.names),
      admins: admins.map((admin) => [admin.code || '', admin.type || '', ...admin.names]),
      places,
    });
  }
  return result;
}

function upsertAdmin(target, key, { code, type }) {
  const existing = target.admins.get(key);
  if (existing) {
    existing.code ||= code;
    existing.type ||= type;
    return existing;
  }
  const admin = { key, code, type, names: new Set() };
  target.admins.set(key, admin);
  return admin;
}

function upsertPlace(target, name, adminKey) {
  const key = `${normalizeLocation(name)}|${adminKey ?? ''}`;
  let place = target.places.get(key);
  if (!place) {
    place = { name, adminKey, population: 0, featureCode: null, names: new Set([name]) };
    target.places.set(key, place);
  }
  return place;
}

function normalizeAdminCode(value, countryCode) {
  let code = String(value || '').trim().toUpperCase();
  if (code.startsWith(`${countryCode}-`)) code = code.slice(countryCode.length + 1);
  // Purely numeric subdivision codes are never written in public profiles.
  if (!/^[A-Z][A-Z0-9]{0,3}$/.test(code)) return null;
  return code;
}

function sortTerms(values, first = null) {
  const sorted = [...values].sort((a, b) => a.localeCompare(b, 'en'));
  if (first == null) return sorted;
  return [first, ...sorted.filter((item) => item !== first)];
}

export function serializeGazetteer(gazetteer) {
  // One record per line keeps diffs reviewable and Git deltas small.
  const head = { ...gazetteer };
  delete head.names;
  delete head.admins;
  delete head.places;
  const lines = [
    '{',
    ...Object.entries(head).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)},`),
    `"names": ${JSON.stringify(gazetteer.names)},`,
    '"admins": [',
    gazetteer.admins.map((item) => JSON.stringify(item)).join(',\n'),
    '],',
    '"places": [',
    gazetteer.places.map((item) => JSON.stringify(item)).join(',\n'),
    ']',
    '}',
  ];
  return `${lines.join('\n')}\n`;
}
