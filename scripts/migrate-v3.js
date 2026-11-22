#!/usr/bin/env node
// One-time migration of pre-GitSphere state into the v3 registry.
//
// Imports, re-attributing every record with the shared v3 resolver:
//   * state/repository-candidates/*.json  (repository-first candidates)
//   * data/*.json                          (previously published rankings)
//   * state/discovery/*.json               (secondary owner discovery)
// Legacy repository records have no node ID; they are marked `legacy` and are
// either resolved to a node ID or dropped before they can be certified.
// Descriptions and homepage URLs from legacy owner discovery are discarded:
// that free text is where the GH013 credential-shaped string came from.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../src/config.js';
import { readJson, writeJson } from '../src/core/store.js';
import { sanitizeCount, sanitizeLogin, sanitizeNameWithOwner, sanitizeText } from '../src/core/sanitize.js';
import { loadSharedResolver } from '../src/geo/resolver.js';
import { Registry } from '../src/discovery/registry.js';
import { OwnerCandidates } from '../src/discovery/owners.js';
import { attributionSummary } from '../src/discovery/records.js';

const root = projectRoot();
const stateDir = path.join(root, 'state');
const resolver = await loadSharedResolver();
const registry = await new Registry({ stateDir }).load();
const owners = await new OwnerCandidates(stateDir).load();
const stats = { repositoryRecords: 0, repositoriesImported: 0, ownerRecords: 0, accountsImported: 0, ownersQueued: 0, rejectedByResolver: 0 };

async function jsonFiles(directory) {
  try {
    return (await readdir(directory)).filter((name) => /^[A-Z]{2}\.json$/.test(name)).map((name) => path.join(directory, name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function legacyRepository(repo, timestamp) {
  const name = sanitizeNameWithOwner(repo?.nameWithOwner);
  const login = sanitizeLogin(repo?.owner?.login);
  if (!name || !login) return null;
  const location = sanitizeText(repo.owner.location, 120);
  const attribution = resolver.resolve(location);
  stats.repositoryRecords += 1;
  if (!attribution.accepted) {
    stats.rejectedByResolver += 1;
    return null;
  }
  return {
    code: attribution.countryCode,
    record: {
      name,
      stars: sanitizeCount(repo.stars ?? repo.stargazerCount),
      forks: sanitizeCount(repo.forks ?? repo.forkCount),
      language: sanitizeText(repo.primaryLanguage?.name ?? repo.primaryLanguage, 40),
      license: sanitizeText(repo.license?.spdxId ?? repo.licenseInfo?.spdxId, 40),
      description: null,
      archived: Boolean(repo.archived ?? repo.isArchived),
      createdAt: repo.createdAt || null,
      pushedAt: repo.pushedAt || null,
      owner: { id: null, login, type: repo.owner.type === 'Organization' ? 'Organization' : 'User', name: sanitizeText(repo.owner.name, 80), location },
      attribution: attributionSummary(attribution),
      seenAt: timestamp,
      verifiedAt: null,
    },
  };
}

for (const file of [...await jsonFiles(path.join(stateDir, 'repository-candidates')), ...await jsonFiles(path.join(root, 'data'))]) {
  const doc = await readJson(file, null);
  if (!doc || doc.schemaVersion === 3) continue;
  const timestamp = doc.updatedAt || doc.generatedAt || null;
  for (const repo of doc.repositories || []) {
    const item = legacyRepository(repo, timestamp);
    if (!item) continue;
    registry.importLegacyRepository(item.code, item.record);
    stats.repositoriesImported += 1;
  }
}

const LEGACY_ACCOUNTS_PER_COUNTRY = 400;
const importedPerCountry = new Map();
for (const file of await jsonFiles(path.join(stateDir, 'discovery'))) {
  const doc = await readJson(file, null);
  const candidates = [...(doc?.candidates || [])].sort(
    (a, b) => (b.topRepository?.stargazerCount || 0) - (a.topRepository?.stargazerCount || 0) || String(a.login).localeCompare(String(b.login)),
  );
  for (const candidate of candidates) {
    stats.ownerRecords += 1;
    const login = sanitizeLogin(candidate.login);
    if (!candidate.id || !login) continue;
    const location = sanitizeText(candidate.location, 120);
    const attribution = resolver.resolve(location);
    if (!attribution.accepted) {
      stats.rejectedByResolver += 1;
      continue;
    }
    const type = candidate.type === 'Organization' ? 'Organization' : 'User';
    const imported = importedPerCountry.get(attribution.countryCode) || 0;
    if (type === 'User' && imported < LEGACY_ACCOUNTS_PER_COUNTRY) {
      importedPerCountry.set(attribution.countryCode, imported + 1);
      registry.upsertAccount({
        id: String(candidate.id),
        databaseId: null,
        login,
        type,
        name: sanitizeText(candidate.name, 80),
        location,
        followers: null,
        publicRepos: null,
        createdAt: null,
        attribution: attributionSummary(attribution),
        seenAt: doc.updatedAt || null,
        sources: ['legacy-owner-discovery'],
      });
      stats.accountsImported += 1;
    }
    const top = candidate.topRepository;
    if (top) {
      const item = legacyRepository({ ...top, owner: { login, type, name: candidate.name, location } }, doc.updatedAt || null);
      if (item) registry.importLegacyRepository(item.code, item.record);
      owners.add(attribution.countryCode, { id: String(candidate.id), login, topStars: sanitizeCount(top.stargazerCount), publicRepos: null });
      stats.ownersQueued += 1;
    }
  }
}

await registry.flush();
await owners.save();
const legacyScan = await readJson(path.join(stateDir, 'repository-first.json'), null);
await writeJson(path.join(stateDir, 'migration.json'), {
  schemaVersion: 3,
  migratedAt: new Date().toISOString(),
  stats,
  legacyRepositoryFirst: legacyScan ? { stats: legacyScan.stats, unresolvedStarCounts: legacyScan.unresolvedStarCounts?.length || 0, highestUnresolvedStars: Math.max(0, ...(legacyScan.unresolvedStarCounts || [])), queue: legacyScan.queue?.length || 0, lastRun: legacyScan.lastRun } : null,
}, { compact: false });
console.log(JSON.stringify(stats));
