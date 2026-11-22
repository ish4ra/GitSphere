#!/usr/bin/env node
// Regenerates geography/<CC>.json from pinned, checksummed upstream datasets.
//
//   node scripts/build-gazetteer.js            # CSC + GeoNames (required)
//   GEOGRAPHY_ALLOW_PARTIAL=1 node scripts/...  # CSC only (local development)
//   GEOGRAPHY_CACHE_DIR=/tmp/geo               # reuse downloaded files
//
// GeoNames dumps are updated daily and are not versioned, so the build
// records their SHA-256 and Last-Modified header in geography/manifest.json.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { projectRoot } from '../src/config.js';
import { COUNTRIES } from '../src/countries.js';
import { GEOGRAPHY_SOURCE } from '../src/geography-source.js';
import { buildGazetteers, serializeGazetteer } from '../src/geo/gazetteer-build.js';
import { readZipEntries } from '../src/geo/zip.js';
import { USER_AGENT } from '../src/core/identity.js';

const GEONAMES = {
  cities: 'https://download.geonames.org/export/dump/cities500.zip',
  admin1: 'https://download.geonames.org/export/dump/admin1CodesASCII.txt',
  license: 'CC BY 4.0',
};

const root = projectRoot();
const geographyDir = path.join(root, 'geography');
const cacheDir = process.env.GEOGRAPHY_CACHE_DIR || null;
const allowPartial = process.env.GEOGRAPHY_ALLOW_PARTIAL === '1';
const outputDir = process.env.GEOGRAPHY_OUTPUT_DIR || geographyDir;

const cscDownload = await fetchCached(GEOGRAPHY_SOURCE.url, 'csc.json.gz');
if (cscDownload.sha256 !== GEOGRAPHY_SOURCE.sha256) {
  throw new Error(`CSC checksum mismatch: expected ${GEOGRAPHY_SOURCE.sha256}, received ${cscDownload.sha256}.`);
}
const csc = JSON.parse(gunzipSync(cscDownload.body).toString('utf8'));

let cities500 = null;
let admin1 = null;
const geonamesMeta = {};
try {
  const zip = await fetchCached(GEONAMES.cities, 'cities500.zip');
  const entry = readZipEntries(zip.body).find((item) => item.name.endsWith('.txt'));
  if (!entry) throw new Error('cities500.zip has no .txt entry');
  cities500 = entry.read().toString('utf8');
  const admin = await fetchCached(GEONAMES.admin1, 'admin1CodesASCII.txt');
  admin1 = admin.body.toString('utf8');
  Object.assign(geonamesMeta, {
    name: 'GeoNames cities500 + admin1CodesASCII',
    license: GEONAMES.license,
    cities500: { url: GEONAMES.cities, sha256: zip.sha256, lastModified: zip.lastModified },
    admin1: { url: GEONAMES.admin1, sha256: admin.sha256, lastModified: admin.lastModified },
  });
} catch (error) {
  if (!allowPartial) {
    throw new Error(`GeoNames download failed (${error.message}); refusing to publish a reduced gazetteer.`);
  }
  console.warn(`GeoNames unavailable (${error.message}); building CSC-only gazetteer for development.`);
}

const gazetteers = buildGazetteers({ csc, catalog: COUNTRIES, cities500, admin1 });
if (gazetteers.size !== COUNTRIES.length) {
  throw new Error(`Expected ${COUNTRIES.length} gazetteers, built ${gazetteers.size}.`);
}

if (cities500) {
  // Structural sanity checks before replacing the committed gazetteer.
  const places = [...gazetteers.values()].reduce((sum, item) => sum + item.counts.places, 0);
  const withPopulation = [...gazetteers.values()].reduce((sum, item) => sum + item.counts.placesWithPopulation, 0);
  if (places < 200_000 || withPopulation < 150_000) {
    throw new Error(`Gazetteer looks truncated (${places} places, ${withPopulation} with population); refusing to publish.`);
  }
  for (const code of ['US', 'IN', 'CN', 'LK', 'DE', 'JP', 'BR', 'GB']) {
    if ((gazetteers.get(code)?.counts.placesWithPopulation || 0) < 50) {
      throw new Error(`Gazetteer for ${code} has too few populated places; refusing to publish.`);
    }
  }
}

await mkdir(outputDir, { recursive: true });
for (const entry of await readdir(outputDir)) {
  if (/^[A-Z]{2}\.json$/.test(entry)) await rm(path.join(outputDir, entry));
}

const sources = [
  {
    name: GEOGRAPHY_SOURCE.name,
    repository: GEOGRAPHY_SOURCE.repository,
    release: GEOGRAPHY_SOURCE.release,
    sha256: GEOGRAPHY_SOURCE.sha256,
    license: GEOGRAPHY_SOURCE.license,
  },
  ...(cities500 ? [geonamesMeta] : []),
];

const totals = { countries: 0, admins: 0, places: 0, placesWithPopulation: 0, countryNames: 0 };
const manifestCountries = {};
for (const country of COUNTRIES) {
  const gazetteer = gazetteers.get(country.code);
  gazetteer.country = { ...gazetteer.country, name: country.name, slug: country.slug };
  const content = serializeGazetteer(gazetteer);
  await writeFile(path.join(outputDir, `${country.code}.json`), content, 'utf8');
  totals.countries += 1;
  totals.admins += gazetteer.counts.admins;
  totals.places += gazetteer.counts.places;
  totals.placesWithPopulation += gazetteer.counts.placesWithPopulation;
  totals.countryNames += gazetteer.counts.countryNames;
  manifestCountries[country.code] = {
    ...gazetteer.counts,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

const manifest = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  complete: Boolean(cities500),
  sources,
  totals,
  countries: manifestCountries,
};
await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await writeFile(path.join(outputDir, 'README.md'), renderReadme(manifest), 'utf8');

console.log(
  `Built ${totals.countries} gazetteers: ${totals.places.toLocaleString('en-US')} places ` +
    `(${totals.placesWithPopulation.toLocaleString('en-US')} with population), ` +
    `${totals.admins.toLocaleString('en-US')} subdivisions. GeoNames: ${cities500 ? 'yes' : 'no'}.`,
);

async function fetchCached(url, filename) {
  if (cacheDir) {
    try {
      const body = await readFile(path.join(cacheDir, filename));
      return { body, sha256: sha256(body), lastModified: null };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (cacheDir) {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, filename), body);
  }
  return { body, sha256: sha256(body), lastModified: response.headers.get('last-modified') };
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function renderReadme(value) {
  const number = (n) => Number(n || 0).toLocaleString('en-US');
  return `# GitSphere Gazetteer

Generated by \`npm run sync:geography\` (\`scripts/build-gazetteer.js\`). Do not edit these files by hand.

Each \`<CC>.json\` file holds one supported country or territory:

- \`names\` — country names, native names, translations and aliases
- \`admins\` — \`[isoCode, type, ...names]\` administrative subdivisions
- \`places\` — \`[population, adminIndex, geonamesFeatureCode, name, ...alternateNames]\`

| Metric | Value |
| --- | ---: |
| Countries and territories | ${number(value.totals.countries)} |
| Administrative subdivisions | ${number(value.totals.admins)} |
| Places (cities, towns, districts) | ${number(value.totals.places)} |
| Places with population data | ${number(value.totals.placesWithPopulation)} |
| GeoNames included | ${value.complete ? 'yes' : 'no (development build)'} |

## Sources and licenses

${value.sources.map((source) => `- **${source.name}** — ${source.license}${source.release ? ` (release \`${source.release}\`)` : ''}`).join('\n')}

Countries States Cities Database is available under the Open Database License (ODbL-1.0).
GeoNames data is licensed under Creative Commons Attribution 4.0 (https://www.geonames.org/).
GitSphere source code is MIT-licensed.

No finite gazetteer covers every settlement or free-text location. Locations that cannot be
attributed unambiguously are recorded as ambiguous or unknown rather than guessed.
`;
}
