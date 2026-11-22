// In-memory registry of attributed repositories and accounts for every
// country, backed by per-country JSON files. Stable GitHub node IDs are the
// deduplication key, so renames and transfers update one record instead of
// creating duplicates, and a record can only ever live in one country.

import path from 'node:path';
import { COUNTRIES, getCountry } from '../countries.js';
import { listCodes, readJson, writeJson } from '../core/store.js';
import { sanitizeText } from '../core/sanitize.js';
import { compareByContributions, compareByFollowers, compareRepositories, RECORD_SCHEMA_VERSION } from './records.js';

export const DEFAULT_LIMITS = Object.freeze({
  repositoryCandidates: 150,
  accounts: 2500,
  followersKeep: 1300,
  contributionsKeep: 1300,
  contributionCandidatesKeep: 900,
});

export class Registry {
  constructor({ stateDir, limits = {}, now = () => new Date().toISOString() }) {
    this.repositoryDir = path.join(stateDir, 'repositories', 'candidates');
    this.accountDir = path.join(stateDir, 'accounts');
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.now = now;
    this.repositoriesByCountry = new Map(COUNTRIES.map((country) => [country.code, new Map()]));
    this.accountsByCountry = new Map(COUNTRIES.map((country) => [country.code, new Map()]));
    this.repositoryHome = new Map(); // id -> code
    this.accountHome = new Map(); // id -> code
    this.dirtyRepositories = new Set();
    this.dirtyAccounts = new Set();
    this.events = { repositoriesMoved: 0, repositoriesRemoved: 0, accountsMoved: 0, accountsRemoved: 0, renamed: 0 };
  }

  async load() {
    for (const code of await listCodes(this.repositoryDir)) {
      const doc = await readJson(path.join(this.repositoryDir, `${code}.json`), null);
      if (doc?.schemaVersion !== RECORD_SCHEMA_VERSION || !this.repositoriesByCountry.has(code)) continue;
      for (const record of doc.repositories || []) {
        if (scrubStoredText(record)) this.dirtyRepositories.add(code);
        this.#placeRepository(code, record);
      }
    }
    for (const code of await listCodes(this.accountDir)) {
      const doc = await readJson(path.join(this.accountDir, `${code}.json`), null);
      if (doc?.schemaVersion !== RECORD_SCHEMA_VERSION || !this.accountsByCountry.has(code)) continue;
      for (const record of doc.accounts || []) {
        if (scrubStoredText(record)) this.dirtyAccounts.add(code);
        this.#placeAccount(code, record);
      }
    }
    return this;
  }

  // ---- repositories -------------------------------------------------------

  /** Inserts/updates a fresh repository observation. Unattributed → removed. */
  upsertRepository(record) {
    if (!record?.id) return null;
    const code = record.attribution?.code || null;
    const previousCode = this.repositoryHome.get(record.id) || null;
    const previous = previousCode ? this.repositoriesByCountry.get(previousCode).get(record.id) : null;

    if (previous && previous.name !== record.name) this.events.renamed += 1;
    if (previousCode && previousCode !== code) {
      this.repositoriesByCountry.get(previousCode).delete(record.id);
      this.repositoryHome.delete(record.id);
      this.dirtyRepositories.add(previousCode);
      if (code) this.events.repositoriesMoved += 1;
      else this.events.repositoriesRemoved += 1;
    }
    this.#dropLegacy(record.name);
    if (!code || !this.repositoriesByCountry.has(code)) return null;

    const merged = { ...previous, ...record };
    if (previous?.revalidatedAt && !record.revalidatedAt) merged.revalidatedAt = previous.revalidatedAt;
    delete merged.legacy;
    this.repositoriesByCountry.get(code).set(record.id, merged);
    this.repositoryHome.set(record.id, code);
    this.dirtyRepositories.add(code);
    return code;
  }

  removeRepository(id) {
    const code = this.repositoryHome.get(id);
    if (!code) return false;
    this.repositoriesByCountry.get(code).delete(id);
    this.repositoryHome.delete(id);
    this.dirtyRepositories.add(code);
    this.events.repositoriesRemoved += 1;
    return true;
  }

  /** Imports a legacy record without a node ID (pre-v3 data). */
  importLegacyRepository(code, record) {
    if (!this.repositoriesByCountry.has(code)) return;
    const key = legacyKey(record.name);
    if ([...this.repositoriesByCountry.get(code).values()].some((item) => item.name?.toLowerCase() === record.name.toLowerCase())) return;
    this.#placeRepository(code, { ...record, id: key, legacy: true });
    this.dirtyRepositories.add(code);
  }

  repositories(code) {
    return [...(this.repositoriesByCountry.get(code)?.values() || [])].sort(compareRepositories);
  }

  repositoryCountries() {
    return [...this.repositoriesByCountry.keys()];
  }

  // ---- accounts -----------------------------------------------------------

  upsertAccount(record, { authoritativeLocation = true } = {}) {
    if (!record?.id || record.type !== 'User') return null;
    const previousCode = this.accountHome.get(record.id) || null;
    const previous = previousCode ? this.accountsByCountry.get(previousCode).get(record.id) : null;
    const code = authoritativeLocation ? record.attribution?.code || null : previousCode;

    if (previousCode && previousCode !== code) {
      this.accountsByCountry.get(previousCode).delete(record.id);
      this.accountHome.delete(record.id);
      this.dirtyAccounts.add(previousCode);
      if (code) this.events.accountsMoved += 1;
      else this.events.accountsRemoved += 1;
    }
    if (!code || !this.accountsByCountry.has(code)) return null;

    const merged = mergeAccount(previous, record);
    this.accountsByCountry.get(code).set(record.id, merged);
    this.accountHome.set(record.id, code);
    this.dirtyAccounts.add(code);
    return code;
  }

  removeAccount(id) {
    const code = this.accountHome.get(id);
    if (!code) return false;
    this.accountsByCountry.get(code).delete(id);
    this.accountHome.delete(id);
    this.dirtyAccounts.add(code);
    this.events.accountsRemoved += 1;
    return true;
  }

  updateAccount(id, patch) {
    const code = this.accountHome.get(id);
    if (!code) return null;
    const current = this.accountsByCountry.get(code).get(id);
    this.accountsByCountry.get(code).set(id, { ...current, ...patch });
    this.dirtyAccounts.add(code);
    return code;
  }

  account(id) {
    const code = this.accountHome.get(id);
    return code ? this.accountsByCountry.get(code).get(id) : null;
  }

  accounts(code) {
    return [...(this.accountsByCountry.get(code)?.values() || [])];
  }

  // ---- persistence --------------------------------------------------------

  async flush() {
    const written = { repositories: [], accounts: [] };
    for (const code of [...this.dirtyRepositories].sort()) {
      const kept = this.repositories(code).slice(0, this.limits.repositoryCandidates);
      const map = this.repositoriesByCountry.get(code);
      for (const record of [...map.values()]) {
        if (!kept.includes(record)) {
          map.delete(record.id);
          this.repositoryHome.delete(record.id);
        }
      }
      if (await writeJson(path.join(this.repositoryDir, `${code}.json`), countryDocument(code, 'repositories', kept))) {
        written.repositories.push(code);
      }
    }
    for (const code of [...this.dirtyAccounts].sort()) {
      const kept = retainAccounts(this.accounts(code), this.limits);
      const map = this.accountsByCountry.get(code);
      const keep = new Set(kept.map((record) => record.id));
      for (const id of [...map.keys()]) {
        if (!keep.has(id)) {
          map.delete(id);
          this.accountHome.delete(id);
        }
      }
      if (await writeJson(path.join(this.accountDir, `${code}.json`), countryDocument(code, 'accounts', kept))) {
        written.accounts.push(code);
      }
    }
    this.dirtyRepositories.clear();
    this.dirtyAccounts.clear();
    return written;
  }

  #placeRepository(code, record) {
    if (!record?.id) return;
    this.repositoriesByCountry.get(code).set(record.id, record);
    this.repositoryHome.set(record.id, code);
  }

  #placeAccount(code, record) {
    if (!record?.id) return;
    this.accountsByCountry.get(code).set(record.id, record);
    this.accountHome.set(record.id, code);
  }

  #dropLegacy(name) {
    if (!name) return;
    const key = legacyKey(name);
    const code = this.repositoryHome.get(key);
    if (!code) return;
    this.repositoriesByCountry.get(code).delete(key);
    this.repositoryHome.delete(key);
    this.dirtyRepositories.add(code);
  }
}

/**
 * Re-applies the current text sanitization to records persisted by older
 * versions, so tightened rules (e.g. email redaction) also clean existing
 * data. Returns true when the record changed.
 */
export function scrubStoredText(record) {
  let changed = false;
  const scrub = (target, field, max) => {
    if (!target || typeof target[field] !== 'string') return;
    const clean = sanitizeText(target[field], max);
    if (clean !== target[field]) {
      target[field] = clean;
      changed = true;
    }
  };
  scrub(record, 'name', record.owner ? 200 : 80); // repositories store nameWithOwner as name
  scrub(record, 'location', 120);
  scrub(record, 'description', 160);
  scrub(record.owner, 'name', 80);
  scrub(record.owner, 'location', 120);
  return changed;
}

export function legacyKey(name) {
  return `legacy:${String(name).toLowerCase()}`;
}

function mergeAccount(previous, record) {
  if (!previous) return { ...record, sources: [...new Set(record.sources || [])].sort() };
  return {
    ...previous,
    ...withoutNulls(record),
    sources: [...new Set([...(previous.sources || []), ...(record.sources || [])])].sort(),
    contributions: record.contributions || previous.contributions || undefined,
  };
}

function withoutNulls(record) {
  const result = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && value !== undefined) result[key] = value;
  }
  // A cleared public location/name is authoritative, not missing data.
  if ('location' in record) result.location = record.location;
  if ('name' in record) result.name = record.name;
  return result;
}

/**
 * Bounded retention that keeps every account relevant to either user
 * ranking: the strongest by followers, the strongest by measured public
 * contributions, and unmeasured accounts with the most public repositories
 * (the contribution-measurement backlog). This keeps low-follower, highly
 * active developers eligible for the contributions ranking.
 */
export function retainAccounts(accounts, limits = DEFAULT_LIMITS) {
  const keep = new Map();
  const add = (list, count) => {
    for (const record of list.slice(0, count)) keep.set(record.id, record);
  };
  add([...accounts].sort(compareByFollowers), limits.followersKeep);
  add(accounts.filter((record) => record.contributions).sort(compareByContributions), limits.contributionsKeep);
  add(
    accounts
      .filter((record) => !record.contributions)
      .sort((a, b) => (b.publicRepos || 0) - (a.publicRepos || 0) || compareByFollowers(a, b)),
    limits.contributionCandidatesKeep,
  );
  return [...keep.values()].sort(compareByFollowers).slice(0, limits.accounts);
}

function countryDocument(code, key, records) {
  const country = getCountry(code);
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    country: { code, name: country.name, slug: country.slug },
    count: records.length,
    [key]: records.map(compactRecord),
  };
}

/** Drops null/undefined/empty fields from persisted records to bound size. */
export function compactRecord(value) {
  if (Array.isArray(value)) return value.map(compactRecord);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    if (Array.isArray(item) && item.length === 0) continue;
    result[key] = typeof item === 'object' ? compactRecord(item) : item;
  }
  return result;
}
