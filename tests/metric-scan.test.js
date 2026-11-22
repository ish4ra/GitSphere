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
