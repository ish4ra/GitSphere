import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceMetricScan, createMetricScanState, ensureCycle, metricCertification, prepareMetricScanState } from '../src/discovery/metric-scan.js';
import { REPOSITORY_SPEC } from '../src/pipeline/steps.js';

const times = ['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z'];

test('an empty queue starts the next refresh cycle instead of idling', () => {
  const state = createMetricScanState({ name: 'repositories', floor: 50, now: times[0] });
  assert.equal(ensureCycle(state, { now: times[0] }), true);
  assert.equal(state.cycle, 1);
  assert.deepEqual(state.queue[0].metric, [50, 100_000_000]);
  state.queue = [];
  assert.equal(ensureCycle(state, { now: times[1] }), true);
  assert.equal(state.cycle, 2);
  assert.equal(state.completedCycles.length, 1);
  assert.equal(state.completedCycles[0].verifiedFloor, 50);
});

test('certification uses the last completed cycle while a new one runs', () => {
  const state = createMetricScanState({ name: 'repositories', floor: 50, now: times[0] });
  ensureCycle(state, { now: times[0] });
  state.queue = [{ metric: [300, 900], created: null }];
  assert.equal(metricCertification(state, { now: times[0] }).verifiedFloor, 901);
  state.queue = [];
  ensureCycle(state, { now: times[1] });
  const certification = metricCertification(state, { now: times[2] });
  assert.equal(certification.basis, 'completed-cycle');
  assert.equal(certification.verifiedFloor, 50);
});

test('a floor change applies from the next cycle', () => {
  const state = createMetricScanState({ name: 'repositories', floor: 50, now: times[0] });
  ensureCycle(state, { now: times[0] });
  const prepared = prepareMetricScanState(state, { name: 'repositories', floor: 30, now: times[1] });
  assert.equal(prepared.floor, 50);
  prepared.queue = [];
  ensureCycle(prepared, { now: times[1] });
  assert.equal(prepared.floor, 30);
});

test('an empty result set completes a cycle without spinning', async () => {
  const state = createMetricScanState({ name: 'repositories', floor: 50, now: times[0] });
  let requests = 0;
  const result = await advanceMetricScan({
    state,
    spec: REPOSITORY_SPEC,
    fetchPage: async () => {
      requests += 1;
      return { count: 0, nodes: [], hasNextPage: false, endCursor: null };
    },
    onNodes: async () => {},
    shouldContinue: () => requests < 100,
    checkpoint: async () => {},
    now: () => times[1],
    log: { info() {}, warn() {} },
  });
  assert.equal(result.cyclesStarted, 2);
  assert.equal(requests, 2);
  assert.ok(state.completedCycles.length >= 1);
});

test('unresolved partitions are recorded per cycle and retried by the next cycle', () => {
  const state = createMetricScanState({ name: 'repositories', floor: 50, now: times[0] });
  ensureCycle(state, { now: times[0] });
  state.queue = [];
  state.unresolved = [{ metric: [80, 80], created: ['2020-01-01T00:00:00Z', '2020-01-01T00:00:30Z'], reason: 'search-window-exceeded-at-minimum-time-span' }];
  assert.equal(metricCertification(state, { now: times[0] }).verifiedFloor, 81, 'certification stops above the unresolved bucket');
  ensureCycle(state, { now: times[1] });
  assert.equal(state.completedCycles.at(-1).unresolved, 1, 'the gap is kept in cycle history');
  assert.equal(state.completedCycles.at(-1).verifiedFloor, 81);
  assert.deepEqual(state.unresolved, [], 'the new cycle starts clean');
  assert.deepEqual(state.queue[0].metric, [50, 100_000_000], 'and re-scans the whole range, including the gap');
});

test('runtime is shared across steps in proportion to their budgets', async () => {
  const { stepDeadline } = await import('../src/pipeline/run.js');
  const budgets = { a: 300, b: 100, c: 0, d: 100 };
  const names = ['a', 'b', 'c', 'd'];
  assert.equal(stepDeadline({ now: 0, runtimeEnd: 1000, budgets, names, index: 0 }), 600);
  // If step a finished early (at t=200), b gets half of the remaining 800.
  assert.equal(stepDeadline({ now: 200, runtimeEnd: 1000, budgets, names, index: 1 }), 600);
  assert.equal(stepDeadline({ now: 600, runtimeEnd: 1000, budgets, names, index: 3 }), 1000);
});
