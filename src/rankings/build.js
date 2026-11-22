// Builds the three independent ranking modes from the shared registry and
// assigns each country exactly one truthful status per mode.
//
// Status semantics (one per country and mode, so totals always sum to 250):
//   published   coverage is established by the scans (see certification)
//   provisional useful partial results; deeper discovery is still running
//   building    no results yet and discovery for the country is still running
//   stale       results exist but have not been re-verified recently
//   empty       discovery finished and found no attributable results
//   blocked     discovery for the country is failing and cannot progress

import { COUNTRIES } from '../countries.js';
import { compareByContributions, compareByFollowers, compareRepositories } from '../discovery/records.js';

export const RANKING_METHODOLOGY_VERSION = '1.0.0';
export const MODES = Object.freeze({
  repositories: { limit: 100, title: 'Top Repositories', metric: 'stars' },
  developers: { limit: 1000, title: 'Top Developers', metric: 'followers' },
  contributors: { limit: 1000, title: 'Top Contributors', metric: 'public contributions' },
});
export const STATUSES = ['published', 'provisional', 'building', 'stale', 'empty', 'blocked'];
export const STALE_AFTER_DAYS = 14;

/**
 * @param {object} input
 * @param {Registry} input.registry
 * @param {object} input.repositoryCertification  metricCertification() of the stars scan
 * @param {object} input.followerCertification     metricCertification() of the followers scan
 * @param {Map<string, object>} input.locationStates   per-country location scan state
 * @param {Map<string, number>} input.pendingOwners    per-country owner-expansion backlog
 */
export function buildRankings({ registry, repositoryCertification, followerCertification, locationStates, pendingOwners = new Map(), now }) {
  const result = { repositories: new Map(), developers: new Map(), contributors: new Map() };
  for (const country of COUNTRIES) {
    const location = locationSummary(locationStates.get(country.code));
    result.repositories.set(country.code, repositoryRanking(country, registry.repositories(country.code), {
      certification: repositoryCertification,
      location,
      pendingOwners: pendingOwners.get(country.code) || 0,
      now,
    }));
    const accounts = registry.accounts(country.code);
    result.developers.set(country.code, developerRanking(country, accounts, { certification: followerCertification, location, now }));
    result.contributors.set(country.code, contributorRanking(country, accounts, { location, now }));
  }
  return result;
}

export function locationSummary(state) {
  if (!state) return { started: false, complete: false, round: 0, termIndex: 0, terms: 0, unresolved: 0, failing: false };
  const last = state.completedRounds?.at(-1) || null;
  const failing = (state.unresolved || []).filter((item) => item.reason === 'query-failed-repeatedly').length;
  return {
    started: true,
    complete: Boolean(last),
    completeWithoutGaps: Boolean(last && last.unresolved === 0),
    lastCompletedAt: last?.completedAt || null,
    round: state.round,
    termIndex: state.termIndex,
    terms: state.terms?.count || 0,
    unresolved: (state.unresolved || []).length + (last?.unresolved || 0),
    failing: failing >= 3 && !last,
  };
}

export function repositoryRanking(country, candidates, { certification, location, pendingOwners = 0, now }) {
  const limit = MODES.repositories.limit;
  const entries = [...candidates].sort(compareRepositories).slice(0, limit);
  const verifiedStars = certification?.verifiedFloor ?? null;
  const cutoff = entries.length ? entries.at(-1).stars : null;
  const legacy = entries.filter((entry) => entry.legacy).length;
  const globallyVerified = entries.length >= limit && verifiedStars != null && cutoff >= verifiedStars;
  const locationVerified = location.completeWithoutGaps && pendingOwners === 0;
  const certified = legacy === 0 && (globallyVerified || locationVerified);
  return finalize('repositories', country, entries, {
    certified,
    location,
    now,
    oldest: oldestTimestamp(entries, (entry) => entry.revalidatedAt || entry.verifiedAt || entry.seenAt),
    coverage: {
      basis: globallyVerified ? 'global-star-scan' : locationVerified ? 'location-discovery' : 'partial',
      verifiedStarFloor: verifiedStars,
      starScan: certification || null,
      cutoffStars: cutoff,
      legacyEntriesPendingRevalidation: legacy,
      ownerExpansionBacklog: pendingOwners,
      candidates: candidates.length,
    },
  });
}

export function developerRanking(country, accounts, { certification, location, now }) {
  const limit = MODES.developers.limit;
  const users = accounts.filter((account) => account.type === 'User' && Number.isFinite(account.followers));
  const entries = users.sort(compareByFollowers).slice(0, limit);
  const verifiedFollowers = certification?.verifiedFloor ?? null;
  const cutoff = entries.length ? entries.at(-1).followers : null;
  const globallyVerified = entries.length >= limit && verifiedFollowers != null && cutoff >= verifiedFollowers;
  const certified = globallyVerified || location.completeWithoutGaps;
  return finalize('developers', country, entries, {
    certified,
    location,
    now,
    oldest: oldestTimestamp(entries, (entry) => entry.seenAt),
    coverage: {
      basis: globallyVerified ? 'global-follower-scan' : location.completeWithoutGaps ? 'location-discovery' : 'partial',
      verifiedFollowerFloor: verifiedFollowers,
      followerScan: certification || null,
      cutoffFollowers: cutoff,
      candidates: users.length,
    },
  });
}

export function contributorRanking(country, accounts, { location, now }) {
  const limit = MODES.contributors.limit;
  const users = accounts.filter((account) => account.type === 'User');
  const measured = users.filter((account) => account.contributions);
  const entries = measured
    .filter((account) => account.contributions.public > 0)
    .sort(compareByContributions)
    .slice(0, limit);
  const backlog = users.length - measured.length;
  // Contribution coverage is established only when every discovered account
  // has been measured and location discovery finished without gaps. Even
  // then it is limited to accounts GitSphere discovered.
  const certified = backlog === 0 && location.completeWithoutGaps && measured.length > 0;
  return finalize('contributors', country, entries, {
    certified,
    location,
    now,
    emptyWhenMeasured: measured.length > 0 && backlog === 0,
    oldest: oldestTimestamp(entries, (entry) => entry.contributions?.measuredAt),
    coverage: {
      basis: certified ? 'measured-discovered-accounts' : 'partial',
      discoveredAccounts: users.length,
      measuredAccounts: measured.length,
      measurementBacklog: backlog,
      window: entries[0]?.contributions ? { from: entries[0].contributions.from, to: entries[0].contributions.to } : null,
      exhaustive: false,
    },
  });
}

function finalize(mode, country, entries, { certified, location, now, oldest, coverage, emptyWhenMeasured = false }) {
  let status;
  const staleBefore = Date.parse(now) - STALE_AFTER_DAYS * 86_400_000;
  if (!entries.length) {
    if (location.failing) status = 'blocked';
    else if (location.complete && (mode !== 'contributors' || emptyWhenMeasured || coverage.discoveredAccounts === 0)) status = 'empty';
    else status = 'building';
  } else if (oldest && Date.parse(oldest) < staleBefore) {
    status = 'stale';
  } else {
    status = certified ? 'published' : 'provisional';
  }
  return {
    mode,
    country: { code: country.code, name: country.name, slug: country.slug, flag: country.flag },
    status,
    entries,
    oldestVerification: oldest,
    coverage: { ...coverage, location },
  };
}

function oldestTimestamp(entries, pick) {
  let oldest = null;
  for (const entry of entries) {
    const value = pick(entry);
    if (value && (!oldest || Date.parse(value) < Date.parse(oldest))) oldest = value;
  }
  return oldest;
}

export function statusCounts(rankings) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const ranking of rankings.values()) counts[ranking.status] += 1;
  counts.total = rankings.size;
  return counts;
}
