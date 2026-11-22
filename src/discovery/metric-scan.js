// Continuous, cycle-based global scans over one search metric (stars for
// repositories, followers for developers). Each cycle enumerates every
// result with metric >= floor using the deterministic partition engine.
// When a cycle completes, the next one starts immediately, so the scan is a
// perpetual refresh loop rather than a one-time bootstrap: star/follower
// counts, renamed repositories, transfers, owner location changes and newly
// eligible results are all re-observed every cycle.

import { frontier, rootPartition, runPartitionedScan, verifiedFloor } from './partitions.js';

export const METRIC_SCAN_SCHEMA_VERSION = 3;
const COMPLETED_HISTORY = 12;

export function createMetricScanState({ name, floor, now }) {
  return {
    schemaVersion: METRIC_SCAN_SCHEMA_VERSION,
    name,
    floor,
    cycle: 0,
    cycleStartedAt: null,
    queue: [],
    unresolved: [],
    stats: { pages: 0, splits: 0, leaves: 0, nodes: 0, cyclePages: 0 },
    completedCycles: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function prepareMetricScanState(existing, { name, floor, now }) {
  if (!existing || existing.schemaVersion !== METRIC_SCAN_SCHEMA_VERSION || existing.name !== name) {
    return createMetricScanState({ name, floor, now });
  }
  // A changed floor applies from the next cycle; the current one keeps its
  // own floor so its certification stays meaningful.
  return { ...existing, nextFloor: floor };
}

/** Starts a new cycle when there is no work left. Returns true if started. */
export function ensureCycle(state, { now }) {
  if (state.queue.length) return false;
  if (state.cycle > 0 && state.cycleStartedAt) completeCycle(state, now);
  state.cycle += 1;
  if (state.nextFloor != null) state.floor = state.nextFloor;
  delete state.nextFloor;
  state.cycleStartedAt = now;
  state.queue = [rootPartition({ min: state.floor })];
  state.unresolved = [];
  state.stats.cyclePages = 0;
  state.stats.cycleNodes = 0;
  return true;
}

function completeCycle(state, now) {
  const previous = state.completedCycles.at(-1);
  if (previous?.cycle === state.cycle) return;
  state.completedCycles.push({
    cycle: state.cycle,
    floor: state.floor,
    verifiedFloor: verifiedFloor({ queue: [], unresolved: state.unresolved, floor: state.floor }),
    startedAt: state.cycleStartedAt,
    completedAt: now,
    pages: state.stats.cyclePages || 0,
    nodes: state.stats.cycleNodes || 0,
    unresolved: state.unresolved.length,
    unresolvedPartitions: state.unresolved.slice(0, 25),
  });
  state.completedCycles = state.completedCycles.slice(-COMPLETED_HISTORY);
}

/**
 * The metric level down to which the scan has verified complete
 * enumeration: the better (lower) of the last completed cycle (if recent)
 * and the in-progress cycle.
 */
export function metricCertification(state, { now, maxCompletedAgeDays = 21 } = {}) {
  if (!state) return { verifiedFloor: null, basis: 'not-started' };
  const current = state.cycle > 0
    ? verifiedFloor({ queue: state.queue, unresolved: state.unresolved, floor: state.floor })
    : null;
  const last = state.completedCycles?.at(-1) || null;
  const lastFresh = last && Date.parse(now) - Date.parse(last.completedAt) <= maxCompletedAgeDays * 86_400_000;
  if (lastFresh && (current == null || last.verifiedFloor <= current)) {
    return { verifiedFloor: last.verifiedFloor, basis: 'completed-cycle', cycle: last.cycle, completedAt: last.completedAt };
  }
  return {
    verifiedFloor: current,
    basis: 'current-cycle',
    cycle: state.cycle,
    frontier: frontier(state.queue),
    startedAt: state.cycleStartedAt,
  };
}

export async function advanceMetricScan({
  state,
  spec,
  fetchPage,
  onNodes,
  shouldContinue,
  checkpoint,
  now,
  log = console,
}) {
  let cyclesStarted = 0;
  const totals = { pages: 0, splits: 0, leaves: 0, unresolved: 0, nodes: 0, failures: 0 };
  // At most two cycle boundaries per run: finishing one cycle and starting
  // the next is fine, but an empty-result floor must not spin.
  while (shouldContinue() && cyclesStarted < 2) {
    if (ensureCycle(state, { now: now() })) {
      cyclesStarted += 1;
      log.info?.(`[${state.name}] cycle ${state.cycle} started (floor ${state.floor}).`);
    }
    const summary = await runPartitionedScan({
      spec,
      state,
      fetchPage,
      onNodes: async (nodes, partition) => {
        state.stats.nodes += nodes.length;
        state.stats.cycleNodes = (state.stats.cycleNodes || 0) + nodes.length;
        await onNodes(nodes, partition);
      },
      shouldContinue,
      checkpoint: async () => {
        state.updatedAt = now();
        await checkpoint();
      },
      log,
    });
    for (const key of Object.keys(totals)) totals[key] += summary[key] || 0;
    state.stats.cyclePages = (state.stats.cyclePages || 0) + summary.pages;
    if (state.queue.length) break;
  }
  if (!state.queue.length && state.cycleStartedAt) completeCycle(state, now());
  return { ...totals, cyclesStarted };
}
