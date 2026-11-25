#!/usr/bin/env node
// One-time recovery for the GitSphere 1.0 launch defect in which repository
// nodes from aliased lookups, owner expansion and top-repository discovery
// lacked `__typename` and were silently discarded. Legacy resolution had
// already deleted the name-only records it was meant to replace.
//
//   node scripts/restore-legacy-repositories.js [git-ref]   (default d9f6afa)
//
// * Re-imports pre-launch legacy repository records (from the given ref)
//   that are no longer stored in any country, re-attributed by the current
//   resolver and still marked `legacy` (pending revalidation, never
//   Published until verified by node ID).
// * Clears owner-expansion timestamps set since launch, because those
//   expansions stored nothing, so the owners are expanded again.
// Verified records and all other crawler state are left untouched. Run it
// once: repeated runs are harmless but can swap a single tied record at a
// country's candidate-limit boundary (verified vs. legacy copy).

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { projectRoot } from '../src/config.js';
import { COUNTRIES } from '../src/countries.js';
import { writeJson, readJson } from '../src/core/store.js';
import { loadSharedResolver } from '../src/geo/resolver.js';
import { Registry } from '../src/discovery/registry.js';
import { OwnerCandidates } from '../src/discovery/owners.js';
import { attributionSummary } from '../src/discovery/records.js';

const ref = process.argv[2] || 'd9f6afa';
const launchedAt = '2026-11-22T10:00:00Z';
const root = projectRoot();
const stateDir = path.join(root, 'state');
const resolver = await loadSharedResolver();
const registry = await new Registry({ stateDir }).load();
const owners = await new OwnerCandidates(stateDir).load();

const present = new Set();
for (const code of registry.repositoryCountries()) {
  for (const record of registry.repositories(code)) present.add(record.name.toLowerCase());
}

const stats = { ref, legacyAtRef: 0, alreadyPresent: 0, restored: 0, unattributable: 0, trimmedByCandidateLimit: 0, ownersReset: 0 };
const restoredNames = new Set();
for (const country of COUNTRIES) {
  let doc;
  try {
    doc = JSON.parse(execFileSync('git', ['show', `${ref}:state/repositories/candidates/${country.code}.json`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    continue;
  }
  for (const record of doc.repositories || []) {
    if (!record.legacy) continue;
    stats.legacyAtRef += 1;
    if (present.has(record.name.toLowerCase())) {
      stats.alreadyPresent += 1;
      continue;
    }
    const attribution = resolver.resolve(record.owner?.location);
    if (!attribution.accepted) {
      stats.unattributable += 1;
      continue;
    }
    const { id, legacy, ...rest } = record;
    registry.importLegacyRepository(attribution.countryCode, { ...rest, attribution: attributionSummary(attribution) });
    present.add(record.name.toLowerCase());
    restoredNames.add(record.name.toLowerCase());
  }
}

for (const list of owners.byCountry.values()) {
  for (const owner of list.values()) {
    if (owner.expandedAt && Date.parse(owner.expandedAt) >= Date.parse(launchedAt)) {
      owner.expandedAt = null;
      stats.ownersReset += 1;
    }
  }
}

await registry.flush();
await owners.save();
// Count what was actually retained: each country keeps its top candidates
// only, so lower-ranked restored records are trimmed (as they would be if
// they had never been lost).
for (const code of registry.repositoryCountries()) {
  for (const record of registry.repositories(code)) if (restoredNames.has(record.name.toLowerCase())) stats.restored += 1;
}
stats.trimmedByCandidateLimit = restoredNames.size - stats.restored;
const migration = (await readJson(path.join(stateDir, 'migration.json'), {})) || {};
migration.typenameRecovery = { ...stats, recoveredAt: new Date().toISOString() };
await writeJson(path.join(stateDir, 'migration.json'), migration, { compact: false });
console.log(JSON.stringify(stats));
