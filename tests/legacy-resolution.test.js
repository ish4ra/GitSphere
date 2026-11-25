import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Registry } from '../src/discovery/registry.js';
import { GitHubClient } from '../src/github/client.js';
import { legacyResolutionStep } from '../src/pipeline/steps.js';
import { createFakeGitHub, noSleep } from './helpers/fake-github.js';

const resolver = {
  resolve: (location) => (/sri lanka/i.test(location || '')
    ? { accepted: true, countryCode: 'LK', confidence: 'high', evidence: 'explicit-country' }
    : { accepted: false, countryCode: null, confidence: 'unknown', evidence: 'unrecognized-location' }),
};

function legacy(name, stars) {
  return { name, stars, owner: { login: name.split('/')[0], type: 'User', location: 'Sri Lanka' }, attribution: { code: 'LK', confidence: 'high', evidence: 'explicit-country' }, seenAt: '2026-10-01T00:00:00Z' };
}

async function run(fetchImpl, records) {
  const registry = await new Registry({ stateDir: await mkdtemp(path.join(os.tmpdir(), 'gitsphere-legacy-')) }).load();
  for (const record of records) registry.importLegacyRepository('LK', record);
  const client = new GitHubClient({ token: 't', fetchImpl, sleep: noSleep, minimumIntervalMs: 0 });
  const counters = { repositoriesSeen: 0, repositoriesAttributed: 0, ambiguousLocations: 0, unknownLocations: 0, accountsSeen: 0, accountsAttributed: 0 };
  const result = await legacyResolutionStep({ client, registry, resolver, counters, now: () => '2026-11-25T00:00:00Z', log: { warn() {} }, canContinue: () => true, persist: async () => {} }, 10);
  return { registry, result };
}

test('legacy records are replaced by verified records, or removed only when GitHub has no such repository', async () => {
  const fake = createFakeGitHub({
    users: [{ id: 'U_k', login: 'kasvith', location: 'Sri Lanka' }, { id: 'U_m', login: 'mover', location: 'Berlin' }],
    repositories: [
      { id: 'R_s', owner: 'kasvith', name: 'simplelb', stars: 560, createdAt: '2020-01-01T00:00:00Z' },
      { id: 'R_m', owner: 'mover', name: 'moved', stars: 90, createdAt: '2020-01-01T00:00:00Z' },
    ],
  });
  const { registry, result } = await run(fake.fetchImpl, [legacy('kasvith/simplelb', 554), legacy('mover/moved', 80), legacy('gone/deleted', 70)]);
  assert.deepEqual(registry.repositories('LK').map((record) => [record.id, record.name, record.stars, Boolean(record.legacy)]), [['R_s', 'kasvith/simplelb', 560, false]]);
  assert.equal(result.resolved, 1);
  assert.equal(result.dropped, 1, 'owner no longer attributable: legitimately dropped');
  assert.equal(result.removed, 1, 'repository no longer exists');
  assert.equal(result.malformed, 0);
});

test('a malformed response never deletes legacy data', async () => {
  const fetchImpl = async () => ({
    status: 200, ok: true, headers: { get: () => null },
    json: async () => ({ data: { r0: { id: 'R_x', nameWithOwner: 'kasvith/simplelb' }, rateLimit: { cost: 1, remaining: 4000 } } }),
  });
  const { registry, result } = await run(fetchImpl, [legacy('kasvith/simplelb', 554)]);
  assert.equal(result.malformed, 1);
  assert.equal(registry.repositories('LK').length, 1);
  assert.equal(registry.repositories('LK')[0].legacy, true);
});
