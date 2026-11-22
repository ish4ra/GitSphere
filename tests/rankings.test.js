import test from 'node:test';
import assert from 'node:assert/strict';
import { getCountry } from '../src/countries.js';
import { contributorRanking, developerRanking, locationSummary, repositoryRanking } from '../src/rankings/build.js';
import { assessProgress } from '../src/pipeline/run.js';
import { contributionRecord, contributionWindow, selectContributionCandidates } from '../src/pipeline/steps.js';

const now = '2026-11-22T00:00:00Z';
const lk = getCountry('LK');
const repo = (index, stars, extra = {}) => ({ id: `R${index}`, name: `o/r${index}`, stars, forks: 0, seenAt: now, verifiedAt: now, ...extra });
const done = { started: true, complete: true, completeWithoutGaps: true, unresolved: 0 };
const running = { started: true, complete: false, completeWithoutGaps: false, unresolved: 0 };

test('a country with fewer than 100 repositories is published once location discovery completes', () => {
  const ranking = repositoryRanking(lk, [repo(1, 7), repo(2, 5)], { certification: { verifiedFloor: 50 }, location: done, now });
  assert.equal(ranking.status, 'published');
  assert.equal(ranking.coverage.basis, 'location-discovery');
  assert.equal(repositoryRanking(lk, [repo(1, 7)], { certification: { verifiedFloor: 50 }, location: running, now }).status, 'provisional');
});

test('a full ranking above the verified star floor is published by the global scan', () => {
  const list = Array.from({ length: 120 }, (_, index) => repo(index, 1000 - index));
  const ranking = repositoryRanking(lk, list, { certification: { verifiedFloor: 600 }, location: running, now });
  assert.equal(ranking.status, 'published');
  assert.equal(ranking.entries.length, 100);
  assert.equal(repositoryRanking(lk, list, { certification: { verifiedFloor: 950 }, location: running, now }).status, 'provisional');
});

test('legacy entries, staleness, empty and building states are reported truthfully', () => {
  assert.equal(repositoryRanking(lk, [repo(1, 9, { legacy: true })], { certification: null, location: done, now }).status, 'provisional');
  assert.equal(repositoryRanking(lk, [repo(1, 9, { verifiedAt: '2026-10-01T00:00:00Z', seenAt: '2026-10-01T00:00:00Z' })], { certification: null, location: done, now }).status, 'stale');
  assert.equal(repositoryRanking(lk, [], { certification: null, location: done, now }).status, 'empty');
  assert.equal(repositoryRanking(lk, [], { certification: null, location: running, now }).status, 'building');
  assert.equal(repositoryRanking(lk, [], { certification: null, location: { ...running, failing: true }, now }).status, 'blocked');
  assert.equal(repositoryRanking(lk, [repo(1, 9)], { certification: null, location: done, pendingOwners: 3, now }).status, 'provisional');
});

test('location summaries require a gap-free round for certification', () => {
  const summary = locationSummary({ round: 2, termIndex: 0, terms: { count: 10 }, unresolved: [], completedRounds: [{ round: 1, completedAt: now, unresolved: 2 }] });
  assert.equal(summary.complete, true);
  assert.equal(summary.completeWithoutGaps, false);
});

test('developer ranking excludes organizations and unknown follower counts', () => {
  const accounts = [
    { id: 'U1', login: 'a', type: 'User', followers: 5, seenAt: now },
    { id: 'O1', login: 'org', type: 'Organization', followers: 99, seenAt: now },
    { id: 'U2', login: 'b', type: 'User', followers: null, seenAt: now },
  ];
  assert.deepEqual(developerRanking(lk, accounts, { certification: null, location: done, now }).entries.map((item) => item.login), ['a']);
});

test('contributors are ranked independently of followers and only with public activity', () => {
  const accounts = [
    { id: 'U1', login: 'famous', type: 'User', followers: 9000, contributions: { public: 10, measuredAt: now } },
    { id: 'U2', login: 'busy', type: 'User', followers: 0, contributions: { public: 4000, measuredAt: now } },
    { id: 'U3', login: 'idle', type: 'User', followers: 3, contributions: { public: 0, measuredAt: now } },
    { id: 'U4', login: 'unmeasured', type: 'User', followers: 50 },
  ];
  const ranking = contributorRanking(lk, accounts, { location: done, now });
  assert.deepEqual(ranking.entries.map((item) => item.login), ['busy', 'famous']);
  assert.equal(ranking.coverage.measurementBacklog, 1);
  assert.equal(ranking.status, 'provisional');
});

test('public contributions exclude restricted counts; the window is one year', () => {
  const record = contributionRecord({ contributionCalendar: { totalContributions: 900 }, restrictedContributionsCount: 150, totalCommitContributions: 500, startedAt: 'a', endedAt: 'b' }, now);
  assert.equal(record.public, 750);
  assert.equal(record.restricted, 150);
  const window = contributionWindow('2026-11-22T13:45:10Z');
  assert.equal(window.to, '2026-11-22T13:00:00.000Z');
  assert.equal(window.from, '2025-11-22T13:00:00.000Z');
});

test('contribution candidates interleave countries and prefer unmeasured active accounts', () => {
  const accounts = new Map([
    ['LK', [{ id: 'a', login: 'a', publicRepos: 1, followers: 900 }, { id: 'b', login: 'b', publicRepos: 300, followers: 0 }]],
    ['JP', [{ id: 'c', login: 'c', publicRepos: 5, followers: 1 }]],
  ]);
  const registry = { accounts: (code) => accounts.get(code) || [] };
  const selected = selectContributionCandidates(registry, { now, refreshDays: 7, limit: 3 }).map((item) => item.login);
  assert.deepEqual(selected.slice(0, 2).sort(), ['b', 'c']);
  assert.equal(selected[2], 'a');
});

test('a run that spends nothing with budget available is a stall, not success', () => {
  const settings = { maxRequests: 900 };
  assert.equal(assessProgress({ api: { requests: 0 }, steps: {}, failures: [], stopReason: null }, settings).ok, false);
  assert.equal(assessProgress({ api: { requests: 5 }, steps: { repositories: { pages: 0 } }, failures: [], stopReason: null }, settings).reason, 'requests-without-progress');
  assert.equal(assessProgress({ api: { requests: 0 }, steps: {}, failures: [], stopReason: 'primary-rate-limit' }, settings).ok, true);
  assert.equal(assessProgress({ api: { requests: 9 }, steps: { repositories: { pages: 9 } }, failures: [], stopReason: null }, settings).ok, true);
});
