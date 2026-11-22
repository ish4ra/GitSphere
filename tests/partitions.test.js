import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, createSpec, frontier, rootPartition, runPartitionedScan, splitPartition, verifiedFloor } from '../src/discovery/partitions.js';
import { GitHubClient } from '../src/github/client.js';
import { searchRepositoriesPage, REPOSITORY_SPEC } from '../src/pipeline/steps.js';
import { createFakeGitHub, noSleep, seeded } from './helpers/fake-github.js';

const CYCLE = '2026-11-01T00:00:00Z';

function dataset({ exactStars = 215, exactCount = 2600, spread = 3000 } = {}) {
  const random = seeded(7);
  const repositories = [];
  for (let index = 0; index < exactCount; index += 1) {
    repositories.push({ id: `R_exact_${index}`, owner: `o${index % 50}`, name: `exact${index}`, stars: exactStars, createdAt: isoAt(random) });
  }
  for (let index = 0; index < spread; index += 1) {
    repositories.push({ id: `R_spread_${index}`, owner: `o${index % 50}`, name: `spread${index}`, stars: 50 + Math.floor(random() ** 3 * 20000), createdAt: isoAt(random) });
  }
  return repositories;
}

function isoAt(random) {
  const start = Date.parse('2008-01-01T00:00:00Z');
  const end = Date.parse('2026-10-01T00:00:00Z');
  return new Date(start + Math.floor(random() * (end - start) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function scanAll(repositories, { state, interruptAfter = Infinity } = {}) {
  const fake = createFakeGitHub({ repositories });
  const client = new GitHubClient({ token: 't', fetchImpl: fake.fetchImpl, maxRequests: 100000, sleep: noSleep, minimumIntervalMs: 0 });
  const scanState = state || { queue: [rootPartition({ min: 50 })], unresolved: [], cycleStartedAt: CYCLE, stats: {} };
  const seen = new Map();
  let pages = 0;
  await runPartitionedScan({
    spec: REPOSITORY_SPEC,
    state: scanState,
    fetchPage: searchRepositoriesPage(client),
    onNodes: async (nodes) => {
      for (const node of nodes) seen.set(node.id, (seen.get(node.id) || 0) + 1);
    },
    shouldContinue: () => pages < interruptAfter,
    checkpoint: async () => {
      pages += 1;
    },
    log: { warn() {}, info() {} },
  });
  return { seen, state: scanState, calls: fake.calls.total };
}

test('query building is deterministic and uses inclusive ranges', () => {
  const spec = createSpec({ base: 'fork:false', metric: 'stars', sort: 'stars-desc' });
  assert.equal(buildQuery(spec, { metric: [10, 20], created: null }), 'fork:false stars:10..20 sort:stars-desc');
  assert.equal(buildQuery(spec, { metric: [215, 215], created: ['2020-01-01T00:00:00Z', '2020-06-30T23:59:59Z'] }),
    'fork:false stars:215 created:2020-01-01T00:00:00Z..2020-06-30T23:59:59Z sort:stars-desc');
});

test('metric splits are non-overlapping, cover the parent, highest first', () => {
  for (const metric of [[50, 100_000_000], [50, 120], [215, 216], [0, 1]]) {
    const { children } = splitPartition(REPOSITORY_SPEC, { metric, created: null }, CYCLE);
    assert.equal(children.length, 2);
    const [high, low] = children;
    assert.equal(high.metric[1], metric[1]);
    assert.equal(low.metric[0], metric[0]);
    assert.equal(low.metric[1] + 1, high.metric[0], `contiguous for ${metric}`);
    assert.ok(high.metric[0] <= high.metric[1] && low.metric[0] <= low.metric[1]);
  }
});

test('exact-star buckets split by creation time down to a minimum span', () => {
  const { children } = splitPartition(REPOSITORY_SPEC, { metric: [215, 215], created: null }, CYCLE);
  assert.deepEqual(children.map((child) => child.metric), [[215, 215], [215, 215]]);
  const [newer, older] = children;
  assert.equal(older.created[0], '2007-10-01T00:00:00Z');
  assert.equal(newer.created[1], CYCLE);
  assert.equal(Date.parse(older.created[1]) + 1000, Date.parse(newer.created[0]));
  const tiny = splitPartition(REPOSITORY_SPEC, { metric: [215, 215], created: ['2020-01-01T00:00:00Z', '2020-01-01T00:00:30Z'] }, CYCLE);
  assert.equal(tiny.unresolved, 'search-window-exceeded-at-minimum-time-span');
});

test('a 2,600-repository exact-star bucket is fully recovered with no duplicates', async () => {
  const repositories = dataset();
  const { seen, state } = await scanAll(repositories);
  assert.equal(state.queue.length, 0);
  assert.equal(state.unresolved.length, 0);
  assert.equal(seen.size, repositories.length, 'every repository enumerated');
  assert.ok([...seen.values()].every((count) => count === 1), 'no repository enumerated twice');
  assert.ok(state.stats.splits > 5);
});

test('an interrupted scan resumes from its checkpoint without loss', async () => {
  const repositories = dataset({ exactCount: 1500, spread: 1500 });
  const first = await scanAll(repositories, { interruptAfter: 9 });
  assert.ok(first.state.queue.length > 0, 'stopped mid-scan');
  const saved = JSON.parse(JSON.stringify(first.state));
  const second = await scanAll(repositories, { state: saved });
  const union = new Set([...first.seen.keys(), ...second.seen.keys()]);
  assert.equal(union.size, repositories.length);
  assert.equal(second.state.queue.length, 0);
});

test('a partition that cannot be split is recorded, not silently dropped', async () => {
  const repositories = Array.from({ length: 1200 }, (_, index) => ({ id: `R${index}`, owner: 'o', name: `r${index}`, stars: 80, createdAt: '2020-05-05T05:05:05Z' }));
  const { seen, state } = await scanAll(repositories);
  assert.equal(state.unresolved.length, 1);
  assert.equal(state.unresolved[0].reason, 'search-window-exceeded-at-minimum-time-span');
  assert.equal(state.unresolved[0].reportedCount, 1200);
  assert.equal(seen.size, 0);
  assert.equal(verifiedFloor({ queue: state.queue, unresolved: state.unresolved, floor: 50 }), 81);
});

test('failing queries rotate, then are recorded after repeated failures', async () => {
  const state = { queue: [rootPartition({ min: 10, max: 20 }), rootPartition({ min: 0, max: 9 })], unresolved: [], cycleStartedAt: CYCLE, stats: {} };
  let calls = 0;
  await runPartitionedScan({
    spec: REPOSITORY_SPEC,
    state,
    fetchPage: async (query) => {
      calls += 1;
      if (query.includes('stars:10..20')) throw new Error('boom');
      return { count: 1, nodes: [{ id: 'x' }], hasNextPage: false, endCursor: null };
    },
    onNodes: async () => {},
    log: { warn() {} },
  });
  assert.equal(state.queue.length, 0);
  assert.equal(state.unresolved.length, 1);
  assert.equal(state.unresolved[0].reason, 'query-failed-repeatedly');
  assert.equal(calls, 4);
});

test('frontier tracks the highest unfinished metric value', () => {
  assert.equal(frontier([{ metric: [100, 200] }, { metric: [50, 99] }]), 200);
  assert.equal(frontier([]), null);
  assert.equal(verifiedFloor({ queue: [{ metric: [100, 200] }], unresolved: [], floor: 50 }), 201);
  assert.equal(verifiedFloor({ queue: [], unresolved: [], floor: 50 }), 50);
});
