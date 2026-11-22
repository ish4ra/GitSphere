import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Registry } from '../src/discovery/registry.js';
import { contributionStep, selectContributionCandidates } from '../src/pipeline/steps.js';

// A stub GraphQL client: any batch containing a "poison" account times out,
// as GitHub does for some very large contribution collections.
function stubClient(poison) {
  const client = {
    stats: { requests: 0 },
    calls: [],
    async graphql(query, variables) {
      client.stats.requests += 1;
      client.calls.push(variables.ids.length);
      if (variables.ids.some((id) => poison.has(id))) throw new Error('Something went wrong while executing your query (timeout)');
      return { data: { nodes: variables.ids.map((id) => ({
        __typename: 'User', id, login: id.toLowerCase(), location: 'Colombo, Sri Lanka', followers: { totalCount: 1 }, repositories: { totalCount: 5 },
        contributionsCollection: { startedAt: variables.from, endedAt: variables.to, totalCommitContributions: 10, totalIssueContributions: 0, totalPullRequestContributions: 0, totalPullRequestReviewContributions: 0, totalRepositoryContributions: 0, restrictedContributionsCount: 4, contributionCalendar: { totalContributions: 14 } },
      })) } };
    },
  };
  return client;
}

async function setup(count) {
  const registry = await new Registry({ stateDir: await mkdtemp(path.join(os.tmpdir(), 'gitsphere-contrib-')) }).load();
  for (let index = 0; index < count; index += 1) {
    registry.upsertAccount({ id: `U${index}`, login: `u${index}`, type: 'User', followers: 1, publicRepos: 100 - index, location: 'Colombo, Sri Lanka', attribution: { code: 'LK', confidence: 'high', evidence: 'explicit-country' }, seenAt: '2026-11-01T00:00:00Z', sources: [] });
  }
  return registry;
}

function context(registry, client, now) {
  return {
    client, registry, now: () => now, log: { warn() {} },
    resolver: { resolve: () => ({ accepted: true, countryCode: 'LK', confidence: 'high', evidence: 'explicit-country' }) },
    counters: { accountsSeen: 0, accountsAttributed: 0, repositoriesSeen: 0, repositoriesAttributed: 0, ambiguousLocations: 0, unknownLocations: 0 },
    settings: { contributionRefreshDays: 7, contributionBatch: 8 },
    canContinue: () => true,
    persist: async () => {},
  };
}

test('a failing account is isolated, deferred with backoff, and never lost', async () => {
  const registry = await setup(20);
  const client = stubClient(new Set(['U0']));
  const result = await contributionStep(context(registry, client, '2026-11-22T00:00:00Z'), 20);
  assert.equal(result.measured, 19, 'every other account measured in the same run');
  assert.equal(result.deferredAccounts, 1);
  const failed = registry.account('U0');
  assert.ok(failed, 'failing account is kept');
  assert.equal(failed.contributions, undefined);
  assert.equal(failed.contributionFailure.count, 1);
  assert.equal(failed.contributionFailure.retryAt, '2026-11-23T00:00:00.000Z');
  assert.equal(registry.account('U1').contributions.public, 10);

  // Before the backoff expires it is not selected; afterwards it is.
  const before = selectContributionCandidates(registry, { now: '2026-11-22T12:00:00Z', refreshDays: 7, limit: 100 });
  assert.ok(!before.some((user) => user.id === 'U0'));
  const after = selectContributionCandidates(registry, { now: '2026-11-23T00:00:01Z', refreshDays: 7, limit: 100 });
  assert.equal(after[0].id, 'U0', 'retried first once due (most public repositories)');

  // A second failure doubles the backoff; a later success clears it.
  await contributionStep(context(registry, stubClient(new Set(['U0'])), '2026-11-23T01:00:00Z'), 5);
  assert.equal(registry.account('U0').contributionFailure.count, 2);
  assert.equal(registry.account('U0').contributionFailure.retryAt, '2026-11-25T01:00:00.000Z');
  await contributionStep(context(registry, stubClient(new Set()), '2026-11-26T00:00:00Z'), 5);
  assert.equal(registry.account('U0').contributions.public, 10);
  assert.equal(registry.account('U0').contributionFailure, undefined);
});

test('failing accounts cannot consume every run: deferred runs spend nothing on them', async () => {
  const registry = await setup(40);
  const poison = new Set(['U0', 'U1', 'U2', 'U3']);
  await contributionStep(context(registry, stubClient(poison), '2026-11-22T00:00:00Z'), 60);
  const client = stubClient(poison);
  const second = await contributionStep(context(registry, client, '2026-11-22T06:00:00Z'), 60);
  assert.equal(second.failedBatches, 0, 'deferred accounts are not retried before their backoff');
  const measured = registry.accounts('LK').filter((user) => user.contributions).length;
  assert.equal(measured, 36);
});
