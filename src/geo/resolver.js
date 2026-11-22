// GitSphere's single, authoritative location resolver. Every ranking mode
// (repositories, followers, contributions) attributes accounts through this
// module, so one account can never be assigned to two different countries by
// two different pipelines.
//
// Attribution is based on the free-text public profile location only. It is
// not a claim about citizenship, nationality, residence or incorporation.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { COUNTRIES } from '../countries.js';
import { projectRoot } from '../config.js';
import {
  COUNTRY_NAME_LOCALES,
  LOCATION_PREFIX,
  METRO_ALIASES,
  NON_GEOGRAPHIC_TERMS,
  PLACE_QUALIFIER_WORDS,
  SUPRANATIONAL_TERMS,
  TERRITORY_PARENTS,
} from './curated.js';
import {
  foldTransliteration,
  normalizeLocation,
  TRANSLITERATION_COUNTRIES,
} from './normalize.js';

export const LOCATION_RESOLVER_VERSION = 3;

// A single place name is attributed to the country of its most significant
// match only when that match is a major place and clearly dominates every
// other country's candidate. "London" (GB 8.9M vs CA 0.4M) resolves; "Portland"
// (US 0.65M) and "Hyderabad" (IN 6.8M vs PK 1.4M) stay ambiguous.
const DOMINANCE_MIN_SCORE = 1_000_000;
const DOMINANCE_RATIO = 10;
const MIN_COUNTRY_NAME_WEIGHT = 5_000_000;

let sharedResolverPromise = null;

export function loadSharedResolver(options = {}) {
  if (!sharedResolverPromise || options.reload) {
    sharedResolverPromise = loadGlobalLocationResolver(options);
  }
  return sharedResolverPromise;
}

export async function loadGlobalLocationResolver({ geographyDir } = {}) {
  const directory = geographyDir || path.join(projectRoot(), 'geography');
  const entries = await readdir(directory, { withFileTypes: true });
  const gazetteers = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[A-Z]{2}\.json$/.test(entry.name)) continue;
    const parsed = JSON.parse(await readFile(path.join(directory, entry.name), 'utf8'));
    if (parsed?.country?.code) gazetteers.push(parsed);
  }
  return createGlobalLocationResolver({ countries: COUNTRIES, gazetteers });
}

export function createGlobalLocationResolver({ countries = COUNTRIES, gazetteers = [] } = {}) {
  const countryCodes = countries.map((country) => country.code);
  const countryIndex = new Map(countryCodes.map((code, index) => [code, index]));
  const countryPopulation = new Float64Array(countryCodes.length);
  const iso3 = new Map();

  const countryNames = new Map(); // norm -> Set<code>
  const addCountryName = (value, code) => {
    const key = normalizeLocation(value);
    if (!key || key.length < 2) return;
    let codes = countryNames.get(key);
    if (!codes) countryNames.set(key, (codes = new Set()));
    codes.add(code);
  };

  for (const country of countries) {
    addCountryName(country.name, country.code);
    for (const alias of country.aliases || []) addCountryName(alias, country.code);
  }
  for (const locale of COUNTRY_NAME_LOCALES) {
    let names;
    try {
      names = new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' });
    } catch {
      continue;
    }
    for (const code of countryCodes) {
      try {
        const name = names.of(code);
        if (name && name !== code) addCountryName(name, code);
      } catch {
        // Unsupported region in this ICU build.
      }
    }
  }

  // Administrative subdivisions.
  const adminCountry = [];
  const adminWeight = [];
  const adminLabel = [];
  const adminNames = new Map(); // norm -> admin ids
  const adminCodes = new Map(); // norm code -> admin ids

  // Places, stored in typed-array-friendly columns to keep memory bounded.
  const placeCountry = [];
  const placeAdmin = [];
  const placePopulation = [];
  const placeNames = new Map(); // norm -> id | id[]
  const foldedNames = new Map(); // folded norm -> id | id[] (South Asia only)

  // Names of each catalog territory, used to re-home duplicate subdivisions.
  const territoryNames = new Map(); // parent code -> Map<norm, territory code>
  for (const gazetteer of gazetteers) {
    const parent = TERRITORY_PARENTS.get(gazetteer.country.code);
    if (!parent) continue;
    let names = territoryNames.get(parent);
    if (!names) territoryNames.set(parent, (names = new Map()));
    const catalog = countries.find((country) => country.code === gazetteer.country.code);
    for (const value of [catalog?.name, ...(catalog?.aliases || []), ...(gazetteer.names || [])]) {
      const key = normalizeLocation(value);
      if (key && !countryNames.get(key)?.has(parent)) names.set(key, gazetteer.country.code);
    }
  }

  for (const gazetteer of gazetteers) {
    const code = gazetteer.country.code;
    const cIndex = countryIndex.get(code);
    if (cIndex == null) continue;
    countryPopulation[cIndex] = Number(gazetteer.country.population) || 0;
    if (gazetteer.country.iso3) iso3.set(gazetteer.country.iso3, code);
    for (const name of gazetteer.names || []) addCountryName(name, code);

    const admins = gazetteer.admins || [];
    const perAdminWeight = Math.max(
      50_000,
      (countryPopulation[cIndex] || 1_000_000) / Math.max(1, admins.length),
    );
    const adminOffset = adminCountry.length;
    const rehome = territoryNames.get(code);
    const adminHome = [];
    for (const [adminCode, type, ...names] of admins) {
      const id = adminCountry.length;
      const territory = rehome && names.map(normalizeLocation).map((key) => rehome.get(key)).find(Boolean);
      const home = territory ? countryIndex.get(territory) : cIndex;
      adminHome.push(home);
      adminCountry.push(home);
      adminWeight.push(perAdminWeight);
      adminLabel.push(names[0] || adminCode);
      for (const name of names) pushMulti(adminNames, normalizeLocation(name), id);
      if (adminCode) pushMulti(adminCodes, normalizeLocation(adminCode), id);
      void type;
    }

    const transliterate = TRANSLITERATION_COUNTRIES.has(code);
    for (const [population, adminIndex, , ...names] of gazetteer.places || []) {
      const id = placeCountry.length;
      placeCountry.push(adminIndex >= 0 ? adminHome[adminIndex] : cIndex);
      placeAdmin.push(adminIndex >= 0 ? adminOffset + adminIndex : -1);
      placePopulation.push(Number(population) || 0);
      const seen = new Set();
      for (const name of names) {
        const key = normalizeLocation(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        pushId(placeNames, key, id);
        if (transliterate) pushId(foldedNames, foldTransliteration(key), id);
      }
    }
  }

  for (const [key, code] of METRO_ALIASES) {
    if (!countryIndex.has(code)) continue;
    const id = placeCountry.length;
    placeCountry.push(countryIndex.get(code));
    placeAdmin.push(-1);
    placePopulation.push(5_000_000);
    pushId(placeNames, key, id);
  }

  const countryNameWeight = (code) =>
    Math.max(MIN_COUNTRY_NAME_WEIGHT, countryPopulation[countryIndex.get(code)] || 0) * 4;

  // A country name is "weak" when it collides with a subdivision or a
  // major place in another country ("Georgia" = GE and US-GA).
  const weakCountryNames = new Set();
  for (const [key, codes] of countryNames) {
    if (codes.size > 1) {
      weakCountryNames.add(key);
      continue;
    }
    const code = [...codes][0];
    const cIndex = countryIndex.get(code);
    const foreignAdmin = (adminNames.get(key) || []).some((id) => adminCountry[id] !== cIndex);
    const foreignMajorPlace = ids(placeNames.get(key)).some(
      (id) => placeCountry[id] !== cIndex && placePopulation[id] >= 1_000_000,
    );
    if (foreignAdmin || foreignMajorPlace) weakCountryNames.add(key);
  }

  // Candidate discovery terms per country: names, subdivisions and the most
  // populous places. Filtered lazily through resolve() so only terms that
  // this resolver itself attributes to the country are ever searched.
  const termCandidates = new Map();
  for (const gazetteer of gazetteers) {
    const code = gazetteer.country.code;
    const catalog = countries.find((country) => country.code === code);
    const places = (gazetteer.places || [])
      .filter((place) => place[0] >= 1000 || /^PPL(?:C|A\d?)$/.test(place[2]))
      .slice(0, 160)
      .map((place) => place[3]);
    termCandidates.set(code, [
      catalog?.name,
      ...(catalog?.aliases || []),
      ...(gazetteer.names || []).slice(0, 40),
      ...(gazetteer.admins || []).map((admin) => admin[2]),
      ...places,
    ].filter(Boolean));
  }

  const cache = new Map();

  function analyzeSegment(norm, raw) {
    const evidence = {
      norm,
      raw,
      strongCountries: new Set(),
      weakCountries: new Set(),
      codeCountries: new Set(),
      admins: adminNames.get(norm) || [],
      adminCodes: [],
      places: ids(placeNames.get(norm)),
      transliterated: false,
    };

    const names = countryNames.get(norm);
    if (names) {
      for (const code of names) {
        if (weakCountryNames.has(norm)) evidence.weakCountries.add(code);
        else evidence.strongCountries.add(code);
      }
    }

    const trimmed = String(raw || '').trim().replace(/\.$/, '');
    if (/^[A-Z]{2}$/.test(trimmed) && countryIndex.has(trimmed)) evidence.codeCountries.add(trimmed);
    if (/^[A-Z]{3}$/.test(trimmed) && iso3.has(trimmed)) evidence.codeCountries.add(iso3.get(trimmed));
    if (/^[A-Za-z]{1,4}$/.test(trimmed.replace(/\./g, ''))) {
      evidence.adminCodes = adminCodes.get(normalizeLocation(trimmed)) || [];
    }

    if (!evidence.places.length && !names && !evidence.admins.length) {
      const folded = foldTransliteration(norm);
      const foldedIds = ids(foldedNames.get(folded));
      if (foldedIds.length) {
        evidence.places = foldedIds;
        evidence.transliterated = true;
      }
    }
    return evidence;
  }

  function hasMatch(evidence) {
    return (
      evidence.strongCountries.size > 0 ||
      evidence.weakCountries.size > 0 ||
      evidence.codeCountries.size > 0 ||
      evidence.admins.length > 0 ||
      evidence.adminCodes.length > 0 ||
      evidence.places.length > 0
    );
  }

  // Expands an unmatched segment into sub-segments: drops qualifier words
  // ("Kalutara South") and splits trailing country/subdivision words that
  // were written without a comma ("Bangalore India", "Portland Oregon").
  function expandSegment(raw) {
    const norm = normalizeLocation(raw);
    const direct = analyzeSegment(norm, raw);
    if (hasMatch(direct)) return [direct];

    const tokens = norm.split(' ');
    const rawTokens = String(raw).trim().split(/[\s-]+/).filter(Boolean);
    if (tokens.length < 2) return [direct];

    for (let tail = 1; tail <= Math.min(3, tokens.length - 1); tail += 1) {
      const head = tokens.slice(0, tokens.length - tail).join(' ');
      const tailNorm = tokens.slice(tokens.length - tail).join(' ');
      const tailRaw = rawTokens.length === tokens.length
        ? rawTokens.slice(rawTokens.length - tail).join(' ')
        : tailNorm;
      const headEvidence = analyzeSegment(head, head);
      const tailEvidence = analyzeSegment(tailNorm, tailRaw);
      if (hasMatch(headEvidence) && hasMatch(tailEvidence)) return [headEvidence, tailEvidence];
      if (tailEvidence.strongCountries.size) {
        const headExpanded = expandSegment(head);
        return [...headExpanded.filter(hasMatch), tailEvidence];
      }
    }

    const withoutQualifiers = tokens.filter((token) => !PLACE_QUALIFIER_WORDS.has(token));
    if (withoutQualifiers.length && withoutQualifiers.length < tokens.length) {
      const stripped = withoutQualifiers.join(' ');
      const evidence = analyzeSegment(stripped, stripped);
      if (hasMatch(evidence)) return [evidence];
    }
    return [direct];
  }

  function placeCandidates(evidence) {
    // country code -> best score for this segment
    const scores = new Map();
    const bump = (code, score) => {
      if ((scores.get(code) || 0) < score) scores.set(code, score);
    };
    for (const code of evidence.strongCountries) bump(code, countryNameWeight(code));
    for (const code of evidence.weakCountries) bump(code, countryNameWeight(code));
    for (const code of evidence.codeCountries) bump(code, countryNameWeight(code));
    for (const id of evidence.admins) bump(countryCodes[adminCountry[id]], adminWeight[id]);
    for (const id of evidence.adminCodes) bump(countryCodes[adminCountry[id]], adminWeight[id]);
    for (const id of evidence.places) bump(countryCodes[placeCountry[id]], Math.max(1, placePopulation[id]));
    return scores;
  }

  function compoundCountries(segments) {
    const found = new Map(); // code -> matched label
    for (let i = 0; i < segments.length; i += 1) {
      for (let j = i + 1; j < segments.length; j += 1) {
        const adminsJ = new Set([...segments[j].admins, ...segments[j].adminCodes]);
        if (!adminsJ.size) continue;
        for (const placeId of segments[i].places) {
          if (placeAdmin[placeId] >= 0 && adminsJ.has(placeAdmin[placeId])) {
            found.set(countryCodes[placeCountry[placeId]], `${segments[i].norm}, ${segments[j].norm}`);
          }
        }
      }
    }
    return found;
  }

  function resolveUncached(location) {
    const raw = String(location ?? '').trim();
    if (!raw) return unknown('missing-location');

    const flagCodes = [...raw.matchAll(/([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/gu)]
      .map((match) => String.fromCharCode(match[1].codePointAt(0) - 127397, match[2].codePointAt(0) - 127397))
      .filter((code) => countryIndex.has(code));

    const cleaned = raw
      .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, ' ')
      .replace(/\p{Extended_Pictographic}/gu, ' ')
      .replace(LOCATION_PREFIX, '')
      .trim();

    const rawSegments = cleaned
      .split(/\s*(?:[,;|/\\·•\n\t()[\]{}<>~→]|\s[-–—]\s|\s+@\s+)\s*/u)
      .map((item) => item.trim())
      .filter(Boolean);

    // "Colombo-PR" / "Portland-OR": a trailing subdivision code attached with
    // a hyphen becomes its own segment.
    const splitSegments = [];
    for (const segment of rawSegments) {
      const match = segment.match(/^(.{2,}?)-([A-Za-z]{2,3})$/u);
      if (match && !hasMatch(analyzeSegment(normalizeLocation(segment), segment))) {
        splitSegments.push(match[1], match[2]);
      } else {
        splitSegments.push(segment);
      }
    }

    let sawNonGeographic = false;
    let sawSupranational = false;
    const segments = [];
    for (const segment of splitSegments) {
      const norm = normalizeLocation(segment);
      if (!norm) continue;
      if (NON_GEOGRAPHIC_TERMS.has(norm)) {
        sawNonGeographic = true;
        continue;
      }
      if (SUPRANATIONAL_TERMS.has(norm)) {
        sawSupranational = true;
        continue;
      }
      segments.push(...expandSegment(segment));
    }

    // The whole location can itself be a known place ("Washington, D.C.").
    const wholeNorm = normalizeLocation(cleaned);
    if (segments.length > 1) {
      const whole = analyzeSegment(wholeNorm, cleaned);
      if (whole.places.length || whole.strongCountries.size) segments.unshift(whole);
    }

    const strong = new Set(flagCodes);
    for (const segment of segments) for (const code of segment.strongCountries) strong.add(code);

    const compounds = compoundCountries(segments);
    const matchedSegments = segments.filter(hasMatch);

    if (!matchedSegments.length && !strong.size) {
      if (sawSupranational) return unknown('supranational-region');
      if (sawNonGeographic) return unknown('non-geographic-location');
      return unknown('unrecognized-location');
    }

    if (strong.size > 1) {
      // A strong country name can be explained away as a subdivision or
      // place of another explicit country only via a compound match.
      const remaining = [...strong].filter((code) => !compounds.size || compounds.has(code));
      if (remaining.length !== 1) return ambiguous('multiple-countries', wholeNorm, [...strong]);
      return accepted(remaining[0], 'high', 'explicit-country-with-place', wholeNorm);
    }

    if (strong.size === 1) {
      const code = [...strong][0];
      if (compounds.size && !compounds.has(code)) {
        return ambiguous('conflicting-place-evidence', wholeNorm, [code, ...compounds.keys()]);
      }
      const others = matchedSegments.filter((segment) => !segment.strongCountries.has(code));
      const consistent = others.some((segment) => placeCandidates(segment).has(code));
      return accepted(
        code,
        'high',
        flagCodes.includes(code) && !segments.some((s) => s.strongCountries.has(code))
          ? 'flag-emoji'
          : consistent
            ? 'explicit-country-with-place'
            : 'explicit-country',
        wholeNorm,
      );
    }

    if (compounds.size === 1) {
      const [code, label] = [...compounds.entries()][0];
      return accepted(code, 'high', 'place-with-subdivision', label);
    }
    if (compounds.size > 1) {
      return ambiguous('ambiguous-compound-place', wholeNorm, [...compounds.keys()]);
    }

    // No explicit country and no compound: combine per-segment candidates.
    const perSegment = matchedSegments.map(placeCandidates).filter((scores) => scores.size > 0);
    let combined = null;
    for (const scores of perSegment) {
      if (!combined) {
        combined = new Map(scores);
        continue;
      }
      for (const code of [...combined.keys()]) {
        if (!scores.has(code)) combined.delete(code);
        else combined.set(code, Math.min(combined.get(code), scores.get(code)));
      }
    }
    if (!combined || combined.size === 0) {
      return ambiguous('conflicting-place-evidence', wholeNorm, unionKeys(perSegment));
    }

    if (
      matchedSegments.length === 1 &&
      matchedSegments[0].codeCountries.size &&
      matchedSegments[0].adminCodes.length &&
      !matchedSegments[0].places.length
    ) {
      return ambiguous('ambiguous-code', wholeNorm, unionKeys(perSegment));
    }

    const ranked = [...combined.entries()].sort((a, b) => b[1] - a[1]);
    const [topCode, topScore] = ranked[0];
    const secondScore = ranked[1]?.[1] || 0;
    const transliterated = matchedSegments.some((segment) => segment.transliterated);
    const onlyCodeEvidence = matchedSegments.every(
      (segment) => segment.codeCountries.size && !segment.places.length && !segment.admins.length,
    );

    if (ranked.length === 1) {
      if (onlyCodeEvidence && matchedSegments.some((segment) => segment.adminCodes.length)) {
        return ambiguous('ambiguous-code', wholeNorm, unionKeys(perSegment));
      }
      const evidence = transliterated
        ? 'transliterated-place'
        : perSegment.length > 1
          ? 'consistent-places'
          : onlyCodeEvidence
            ? 'country-code'
            : 'recognized-place';
      return accepted(topCode, 'medium', evidence, wholeNorm);
    }

    const multiSegment = perSegment.length > 1;
    if (
      (multiSegment || topScore >= DOMINANCE_MIN_SCORE) &&
      topScore >= DOMINANCE_RATIO * Math.max(1, secondScore)
    ) {
      return accepted(topCode, 'medium', multiSegment ? 'consistent-places' : 'dominant-place', wholeNorm);
    }

    const weakOnly = matchedSegments.some((segment) => segment.weakCountries.size);
    return ambiguous(
      weakOnly ? 'ambiguous-country-name' : 'ambiguous-place',
      wholeNorm,
      ranked.map(([code]) => code),
    );
  }

  return {
    version: LOCATION_RESOLVER_VERSION,
    resolve(location) {
      const key = String(location ?? '');
      let result = cache.get(key);
      if (!result) {
        result = resolveUncached(key);
        if (cache.size > 200_000) cache.clear();
        cache.set(key, result);
      }
      return result;
    },
    isCountryName(value, code) {
      return Boolean(countryNames.get(normalizeLocation(value))?.has(code));
    },
    discoveryTerms(code, { limit = 220 } = {}) {
      const terms = [];
      const seen = new Set();
      for (const term of termCandidates.get(code) || []) {
        const key = normalizeLocation(term);
        if (!key || key.length < 3 || seen.has(key)) continue;
        seen.add(key);
        if (NON_GEOGRAPHIC_TERMS.has(key) || SUPRANATIONAL_TERMS.has(key)) continue;
        // GitHub location search is token-based: "Kalutara" already matches
        // "Kalutara South", so terms containing an earlier term are skipped.
        if (terms.some((item) => (` ${key} `).includes(` ${item.key} `))) continue;
        const result = this.resolve(term);
        if (result.accepted && result.countryCode === code) terms.push({ key, term: String(term).replace(/["\\]/g, '') });
        if (terms.length >= limit) break;
      }
      return terms.map((item) => item.term);
    },
    countryNameTerms(code) {
      const terms = [];
      for (const [key, codes] of countryNames) if (codes.has(code) && codes.size === 1) terms.push(key);
      return terms;
    },
    stats: {
      countries: countryCodes.length,
      countryNames: countryNames.size,
      admins: adminCountry.length,
      places: placeCountry.length,
      placeNames: placeNames.size,
    },
  };
}

function pushMulti(map, key, id) {
  if (!key) return;
  const list = map.get(key);
  if (list) {
    if (!list.includes(id)) list.push(id);
  } else map.set(key, [id]);
}

function pushId(map, key, id) {
  if (!key) return;
  const current = map.get(key);
  if (current === undefined) map.set(key, id);
  else if (typeof current === 'number') {
    if (current !== id) map.set(key, [current, id]);
  } else if (!current.includes(id)) current.push(id);
}

function ids(value) {
  if (value === undefined) return [];
  return typeof value === 'number' ? [value] : value;
}

function unionKeys(maps) {
  const keys = new Set();
  for (const map of maps) for (const key of map.keys()) keys.add(key);
  return [...keys].sort();
}

function accepted(countryCode, confidence, evidence, matched) {
  return { accepted: true, countryCode, confidence, evidence, matched };
}

function ambiguous(evidence, matched, conflicts = []) {
  return {
    accepted: false,
    countryCode: null,
    confidence: 'ambiguous',
    evidence,
    matched,
    conflicts: [...new Set(conflicts)].sort().slice(0, 12),
  };
}

function unknown(evidence) {
  return { accepted: false, countryCode: null, confidence: 'unknown', evidence, matched: null };
}
