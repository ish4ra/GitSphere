// Per-country location discovery. For every country, each discovery term
// (country names, subdivisions, populous places) is searched as
// `location:"<term>" type:user` (partitioned by followers) and
// `location:"<term>" type:org` (partitioned by public repositories). Every
// account found is attributed by the shared resolver — never by the search
// term — so "Colombo, Brazil" found via "Colombo" lands in Brazil.
//
// This finds developers and repositories in countries whose top entries sit
// below the global star/follower scan floors (small countries), and it
// discovers low-follower developers for the contributions ranking.

import { createSpec, rootPartition, runPartitionedScan } from './partitions.js';

export const LOCATION_SCAN_SCHEMA_VERSION = 3;
const UNRESOLVED_LIMIT = 200;

export function locationSpecs(term) {
  const quoted = `location:"${String(term).replace(/["\\]/g, '')}"`;
  return [
    { kind: 'users', spec: createSpec({ base: `${quoted} type:user`, metric: 'followers', sort: 'followers-desc' }) },
    { kind: 'organizations', spec: createSpec({ base: `${quoted} type:org`, metric: 'repos', sort: 'repositories-desc' }) },
  ];
}

export function termsFingerprint(terms) {
  let hash = 2166136261;
  for (const char of terms.join('\u0001')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${terms.length}:${hash.toString(16)}`;
}

export function createLocationState(code, terms, now) {
  return {
    schemaVersion: LOCATION_SCAN_SCHEMA_VERSION,
    country: code,
    round: 1,
    roundStartedAt: now,
    terms: { count: terms.length, fingerprint: termsFingerprint(terms) },
    termIndex: 0,
    specIndex: 0,
    active: null,
    unresolved: [],
    completedRounds: [],
    stats: { requests: 0, pages: 0, accounts: 0 },
    updatedAt: now,
  };
}

export function prepareLocationState(existing, code, terms, now) {
  if (!existing || existing.schemaVersion !== LOCATION_SCAN_SCHEMA_VERSION) {
    return createLocationState(code, terms, now);
  }
  const fingerprint = termsFingerprint(terms);
  if (existing.terms?.fingerprint !== fingerprint) {
    // Gazetteer changed: restart term coverage but keep history.
    return {
      ...createLocationState(code, terms, now),
      round: (existing.round || 1) + 1,
      completedRounds: existing.completedRounds || [],
    };
  }
  return existing;
}

export function lastCompletedRound(state) {
  return state?.completedRounds?.at(-1) || null;
}

/** True when a full round finished without unresolved partitions. */
export function locationCoverageComplete(state) {
  const last = lastCompletedRound(state);
  return Boolean(last && last.unresolved === 0);
}

export function isRestDue(state, now, refreshDays) {
  // A country whose round completed recently rests until its refresh is due.
  if (state.termIndex !== 0 || state.active) return true;
  const last = lastCompletedRound(state);
  if (!last || last.round !== state.round - 1) return true;
  return Date.parse(now) - Date.parse(last.completedAt) >= refreshDays * 86_400_000;
}

/**
 * Advances one country's location discovery by at most `slice` requests.
 */
export async function advanceLocationScan({
  state,
  terms,
  fetchPage,
  onNodes,
  shouldContinue,
  slice,
  checkpoint,
  now,
  log = console,
}) {
  let used = 0;
  const limited = () => used < slice && shouldContinue();
  const countingFetch = async (...args) => {
    used += 1;
    state.stats.requests += 1;
    return fetchPage(...args);
  };

  while (limited()) {
    if (state.termIndex >= terms.length) {
      state.completedRounds.push({
        round: state.round,
        startedAt: state.roundStartedAt,
        completedAt: now(),
        terms: terms.length,
        unresolved: state.unresolved.length,
      });
      state.completedRounds = state.completedRounds.slice(-6);
      state.round += 1;
      state.roundStartedAt = now();
      state.termIndex = 0;
      state.specIndex = 0;
      state.active = null;
      state.unresolved = [];
      await checkpoint();
      break; // the next round starts after the refresh rest period
    }

    const term = terms[state.termIndex];
    const specs = locationSpecs(term);
    const current = specs[state.specIndex];
    if (!state.active) {
      state.active = { term, kind: current.kind, queue: [rootPartition({ min: 0 })], unresolved: [], cycleStartedAt: now(), stats: {} };
    }

    await runPartitionedScan({
      spec: current.spec,
      state: state.active,
      fetchPage: countingFetch,
      onNodes: async (nodes) => {
        state.stats.pages += 1;
        state.stats.accounts += nodes.length;
        await onNodes(nodes, { term, kind: current.kind });
      },
      shouldContinue: limited,
      checkpoint,
      log,
    });

    if (state.active.queue.length) break;

    for (const item of state.active.unresolved || []) {
      state.unresolved.push({ term, kind: current.kind, metric: item.metric, created: item.created, reason: item.reason });
    }
    state.unresolved = state.unresolved.slice(-UNRESOLVED_LIMIT);
    state.active = null;
    state.specIndex += 1;
    if (state.specIndex >= specs.length) {
      state.specIndex = 0;
      state.termIndex += 1;
    }
    state.updatedAt = now();
    await checkpoint();
  }
  return used;
}
