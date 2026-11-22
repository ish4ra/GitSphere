// Individual pipeline steps. Each step spends at most its own share of the
// API budget, checkpoints after every page/batch, and reports what it did so
// the run summary can tell real progress apart from a successful no-op.

import path from 'node:path';
import { COUNTRIES } from '../countries.js';
import { readJson, writeJson } from '../core/store.js';
import { safeErrorMessage } from '../core/sanitize.js';
import { createSpec } from '../discovery/partitions.js';
import { advanceMetricScan, prepareMetricScanState } from '../discovery/metric-scan.js';
import {
  advanceLocationScan,
  isRestDue,
  prepareLocationState,
} from '../discovery/location-scan.js';
import {
  accountFromNode,
  accountFromRepositoryOwner,
  compareByFollowers,
  repositoryFromNode,
} from '../discovery/records.js';
import {
  CONTRIBUTIONS,
  NODES_ACCOUNTS,
  NODES_REPOSITORIES,
  OWNER_REPOSITORIES,
  SEARCH_ACCOUNTS,
  SEARCH_REPOSITORIES,
  repositoriesByName,
} from '../github/queries.js';
import { sanitizeNameWithOwner } from '../core/sanitize.js';

export const REPOSITORY_SPEC = createSpec({ base: 'fork:false', metric: 'stars', sort: 'stars-desc' });
export const FOLLOWER_SPEC = createSpec({ base: 'type:user', metric: 'followers', sort: 'followers-desc' });

export function searchRepositoriesPage(client) {
  return async (query, cursor, first = 100) => {
    const { data } = await client.graphql(SEARCH_REPOSITORIES, { query, first, cursor: cursor || null });
    return pageOf(data.search, data.search.repositoryCount);
  };
}

export function searchAccountsPage(client, { withTopRepository = false } = {}) {
  return async (query, cursor, first = 100) => {
    const { data } = await client.graphql(SEARCH_ACCOUNTS, {
      query,
      first: withTopRepository ? Math.min(first, 50) : first,
      cursor: cursor || null,
      withTopRepository,
    });
    return pageOf(data.search, data.search.userCount);
  };
}

function pageOf(search, count) {
  return {
    count: Number(count || 0),
    nodes: search.nodes || [],
    hasNextPage: Boolean(search.pageInfo?.hasNextPage),
    endCursor: search.pageInfo?.endCursor || null,
  };
}

/** Attributes and stores one repository node (and its user owner). */
export function ingestRepository(context, node, { cycle = null } = {}) {
  const { resolver, registry, now, counters } = context;
  if (!node || node.__typename !== 'Repository') return;
  counters.repositoriesSeen += 1;
  const attribution = resolver.resolve(node.owner?.location);
  if (!attribution.accepted) {
    counters[attribution.confidence === 'ambiguous' ? 'ambiguousLocations' : 'unknownLocations'] += 1;
  }
  const record = repositoryFromNode(node, { attribution, now: now(), cycle });
  if (!record) return;
  if (registry.upsertRepository(record)) counters.repositoriesAttributed += 1;
  const owner = accountFromRepositoryOwner(node.owner, { attribution, now: now() });
  if (owner) registry.upsertAccount(owner);
}

export function ingestAccount(context, node, source) {
  const { resolver, registry, now, counters } = context;
  if (!node || !['User', 'Organization'].includes(node.__typename)) return null;
  counters.accountsSeen += 1;
  const attribution = resolver.resolve(node.location);
  const record = accountFromNode(node, { attribution, now: now(), source });
  if (!record) return null;
  if (record.type === 'User' && registry.upsertAccount(record)) counters.accountsAttributed += 1;
  for (const repository of node.topRepositories?.nodes || []) ingestRepository(context, repository);
  return { record, attribution };
}

async function metricStep(context, { name, spec, fileName, floor, fetchPage, ingest, budget }) {
  const { stateDir, now, log } = context;
  const file = path.join(stateDir, fileName);
  const state = prepareMetricScanState(await readJson(file, null), { name, floor, now: now() });
  const start = context.client.stats.requests;
  const result = await advanceMetricScan({
    state,
    spec,
    fetchPage,
    onNodes: async (nodes) => {
      for (const node of nodes) ingest(node, state.cycle);
    },
    shouldContinue: () => context.canContinue() && context.client.stats.requests - start < budget,
    // Registry first, then scan state: the scan checkpoint never runs ahead
    // of the records it has already ingested.
    checkpoint: () => context.persist(() => writeJson(file, state)),
    now,
    log,
  });
  await context.persist(() => writeJson(file, state), { force: true });
  return { requests: context.client.stats.requests - start, ...result, cycle: state.cycle, queue: state.queue.length };
}

export function repositoryScanStep(context, budget) {
  return metricStep(context, {
    name: 'repositories',
    spec: REPOSITORY_SPEC,
    fileName: 'repositories/scan.json',
    floor: context.settings.repositoryStarFloor,
    fetchPage: searchRepositoriesPage(context.client),
    ingest: (node, cycle) => ingestRepository(context, node, { cycle }),
    budget,
  });
}

export function followerScanStep(context, budget) {
  return metricStep(context, {
    name: 'followers',
    spec: FOLLOWER_SPEC,
    fileName: 'users/scan.json',
    floor: context.settings.followerFloor,
    fetchPage: searchAccountsPage(context.client),
    ingest: (node) => ingestAccount(context, node, 'followers-scan'),
    budget,
  });
}

/**
 * Round-robin location discovery with a per-country slice, so large
 * countries cannot starve small ones. Countries that completed a round
 * recently rest until their refresh is due.
 */
export async function locationScanStep(context, budget) {
  const { stateDir, now, resolver, settings, log } = context;
  const indexFile = path.join(stateDir, 'locations', 'index.json');
  const index = (await readJson(indexFile, null)) || { schemaVersion: 3, pointer: 0, passes: 0 };
  const codes = COUNTRIES.map((country) => country.code).sort();
  const start = context.client.stats.requests;
  const fetchPage = searchAccountsPage(context.client, { withTopRepository: true });
  const touched = new Set();
  let visited = 0;
  const owners = context.ownerCandidates;

  while (context.canContinue() && context.client.stats.requests - start < budget && visited < codes.length) {
    const code = codes[index.pointer % codes.length];
    index.pointer = (index.pointer + 1) % codes.length;
    if (index.pointer === 0) index.passes += 1;
    visited += 1;

    const terms = resolver.discoveryTerms(code);
    const file = path.join(stateDir, 'locations', `${code}.json`);
    const state = prepareLocationState(await readJson(file, null), code, terms, now());
    if (!terms.length) {
      await writeJson(file, state);
      continue;
    }
    if (!isRestDue(state, now(), settings.locationRefreshDays)) continue;

    const used = await advanceLocationScan({
      state,
      terms,
      fetchPage,
      onNodes: async (nodes) => {
        for (const node of nodes) {
          const result = ingestAccount(context, node, 'location-scan');
          const top = node?.topRepositories?.nodes?.[0];
          if (result?.attribution.accepted && top && (node.repositories?.totalCount || 0) > 1) {
            owners.add(result.attribution.countryCode, {
              id: String(node.id),
              login: result.record.login,
              topStars: top.stargazerCount || 0,
              publicRepos: node.repositories?.totalCount || 0,
            });
          }
        }
      },
      shouldContinue: () => context.canContinue() && context.client.stats.requests - start < budget,
      slice: settings.locationSlice,
      checkpoint: () => context.persist(() => writeJson(file, state)),
      now,
      log,
    });
    if (used) touched.add(code);
    await context.persist(() => writeJson(file, state), { force: true });
    await writeJson(indexFile, index);
  }
  await writeJson(indexFile, index);
  return { requests: context.client.stats.requests - start, countries: touched.size, pointer: index.pointer };
}

/** Expands multi-repository owners whose top repository could rank. */
export async function ownerExpansionStep(context, budget) {
  const { client, registry, now } = context;
  const start = client.stats.requests;
  const owners = context.ownerCandidates;
  const queue = owners.due(now(), context.settings.ownerExpansionDays, (code) => {
    const list = registry.repositories(code);
    return list.length >= 100 ? list[99].stars : 0;
  });
  let expanded = 0;
  while (queue.length && context.canContinue() && client.stats.requests - start < budget) {
    const batch = queue.splice(0, 10);
    try {
      const { data } = await client.graphql(OWNER_REPOSITORIES, { ids: batch.map((item) => item.id), first: 30 }, { allowPartialErrors: true });
      for (const node of data.nodes || []) {
        for (const repository of node?.repositories?.nodes || []) ingestRepository(context, repository);
      }
    } catch (error) {
      if (error?.name === 'GitHubBudgetError') throw error;
      context.log.warn?.(`Owner expansion batch failed: ${safeErrorMessage(error)}`);
    }
    for (const item of batch) owners.markExpanded(item.id, now());
    expanded += batch.length;
  }
  await owners.save();
  return { requests: client.stats.requests - start, ownersExpanded: expanded, backlog: queue.length };
}

/**
 * Re-fetches ranked repositories by stable node ID before publication:
 * removes deleted/private/forked repositories, follows renames and transfers,
 * and re-attributes repositories whose owner location changed.
 */
export async function repositoryRevalidationStep(context, budget) {
  const { client, registry, now, settings } = context;
  const start = client.stats.requests;
  const staleBefore = Date.parse(now()) - settings.repositoryRevalidateHours * 3_600_000;
  const due = [];
  for (const code of registry.repositoryCountries()) {
    for (const record of registry.repositories(code).slice(0, 110)) {
      if (record.legacy) continue;
      const verified = Date.parse(record.verifiedAt || 0);
      if (!(verified > staleBefore)) due.push(record);
    }
  }
  due.sort((a, b) => Date.parse(a.verifiedAt || 0) - Date.parse(b.verifiedAt || 0));
  const result = { requests: 0, checked: 0, removed: 0, moved: 0, backlog: 0 };
  while (due.length && context.canContinue() && client.stats.requests - start < budget) {
    const batch = due.splice(0, 50);
    const { data } = await client.graphql(NODES_REPOSITORIES, { ids: batch.map((item) => item.id) }, { allowPartialErrors: true });
    (data.nodes || []).forEach((node, offset) => {
      const previous = batch[offset];
      result.checked += 1;
      if (!node || node.__typename !== 'Repository' || node.isFork || node.isPrivate) {
        registry.removeRepository(previous.id);
        result.removed += 1;
        return;
      }
      const before = registry.repositoryHome.get(previous.id);
      ingestRepository(context, node, { cycle: previous.cycle ?? null });
      const after = registry.repositoryHome.get(previous.id);
      if (after) registry.repositoriesByCountry.get(after).get(previous.id).revalidatedAt = now();
      if (before !== after) result.moved += 1;
    });
    await context.persist();
  }
  result.requests = client.stats.requests - start;
  result.backlog = due.length;
  return result;
}

/** Refreshes followers/location/login for ranked developers by node ID. */
export async function accountRefreshStep(context, budget) {
  const { client, registry, now, settings } = context;
  const start = client.stats.requests;
  const staleBefore = Date.parse(now()) - settings.accountRefreshHours * 3_600_000;
  const due = [];
  for (const country of COUNTRIES) {
    const users = registry.accounts(country.code).sort(compareByFollowers).slice(0, 1050);
    for (const record of users) if (!(Date.parse(record.seenAt || 0) > staleBefore)) due.push(record);
  }
  due.sort((a, b) => Date.parse(a.seenAt || 0) - Date.parse(b.seenAt || 0));
  const result = { requests: 0, checked: 0, removed: 0, backlog: 0 };
  while (due.length && context.canContinue() && client.stats.requests - start < budget) {
    const batch = due.splice(0, 100);
    const { data } = await client.graphql(NODES_ACCOUNTS, { ids: batch.map((item) => item.id) }, { allowPartialErrors: true });
    (data.nodes || []).forEach((node, offset) => {
      result.checked += 1;
      if (!node || node.__typename !== 'User') {
        registry.removeAccount(batch[offset].id);
        result.removed += 1;
        return;
      }
      ingestAccount(context, node, 'refresh');
    });
    await context.persist();
  }
  result.requests = client.stats.requests - start;
  result.backlog = due.length;
  return result;
}

export function contributionWindow(nowIso) {
  const to = new Date(nowIso);
  to.setUTCMinutes(0, 0, 0);
  const from = new Date(to);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Selects users for contribution measurement independently of follower
 * ranking cutoffs: never-measured accounts first (most public repositories
 * first), then stale measurements of currently ranked contributors. Countries
 * are interleaved so no country starves.
 */
export function selectContributionCandidates(registry, { now, refreshDays, limit }) {
  const staleBefore = Date.parse(now) - refreshDays * 86_400_000;
  const perCountry = COUNTRIES.map((country) => {
    const users = registry.accounts(country.code);
    const unmeasured = users
      .filter((user) => !user.contributions)
      .sort((a, b) => (b.publicRepos || 0) - (a.publicRepos || 0) || (b.followers || 0) - (a.followers || 0) || a.login.localeCompare(b.login));
    const stale = users
      .filter((user) => user.contributions && !(Date.parse(user.contributions.measuredAt) > staleBefore))
      .sort((a, b) => (b.contributions.public || 0) - (a.contributions.public || 0));
    return [...unmeasured, ...stale];
  });
  const selected = [];
  for (let round = 0; selected.length < limit; round += 1) {
    let added = false;
    for (const list of perCountry) {
      if (list[round]) {
        selected.push(list[round]);
        added = true;
        if (selected.length >= limit) break;
      }
    }
    if (!added) break;
  }
  return selected;
}

export function contributionRecord(collection, measuredAt) {
  if (!collection) return null;
  const total = collection.contributionCalendar?.totalContributions || 0;
  const restricted = collection.restrictedContributionsCount || 0;
  return {
    public: Math.max(0, total - restricted),
    calendarTotal: total,
    restricted,
    commits: collection.totalCommitContributions || 0,
    issues: collection.totalIssueContributions || 0,
    pullRequests: collection.totalPullRequestContributions || 0,
    reviews: collection.totalPullRequestReviewContributions || 0,
    repositories: collection.totalRepositoryContributions || 0,
    from: collection.startedAt,
    to: collection.endedAt,
    measuredAt,
  };
}

export async function contributionStep(context, budget) {
  const { client, registry, now, settings, log } = context;
  const start = client.stats.requests;
  const window = contributionWindow(now());
  const candidates = selectContributionCandidates(registry, {
    now: now(),
    refreshDays: settings.contributionRefreshDays,
    limit: budget * settings.contributionBatch,
  });
  const result = { requests: 0, measured: 0, removed: 0, failedBatches: 0, window };
  let batchSize = settings.contributionBatch;
  while (candidates.length && context.canContinue() && client.stats.requests - start < budget) {
    const batch = candidates.splice(0, batchSize);
    try {
      const { data } = await client.graphql(CONTRIBUTIONS, { ids: batch.map((item) => item.id), ...window }, { allowPartialErrors: true });
      (data.nodes || []).forEach((node, offset) => {
        if (!node || node.__typename !== 'User') {
          registry.removeAccount(batch[offset].id);
          result.removed += 1;
          return;
        }
        const ingested = ingestAccount(context, node, 'contributions');
        if (ingested?.record && registry.account(node.id)) {
          registry.updateAccount(node.id, { contributions: contributionRecord(node.contributionsCollection, now()) });
          result.measured += 1;
        }
      });
      batchSize = Math.min(settings.contributionBatch, batchSize + 2);
    } catch (error) {
      if (error?.name === 'GitHubBudgetError') throw error;
      // Contribution queries can time out on very active accounts: halve.
      result.failedBatches += 1;
      if (batch.length > 1) candidates.unshift(...batch);
      batchSize = Math.max(1, Math.floor(batch.length / 2));
      log.warn?.(`Contribution batch of ${batch.length} failed (${safeErrorMessage(error)}); retrying with ${batchSize}.`);
    }
    await context.persist();
  }
  result.requests = client.stats.requests - start;
  result.backlog = candidates.length;
  return result;
}

/**
 * Resolves records migrated from pre-v3 data (name only, no node ID) to
 * stable IDs. Missing repositories are dropped instead of being published.
 */
export async function legacyResolutionStep(context, budget) {
  const { client, registry } = context;
  const start = client.stats.requests;
  const legacy = [];
  for (const code of registry.repositoryCountries()) {
    for (const record of registry.repositories(code)) if (record.legacy) legacy.push(record);
  }
  legacy.sort((a, b) => (b.stars || 0) - (a.stars || 0));
  const result = { requests: 0, resolved: 0, removed: 0, backlog: 0 };
  while (legacy.length && context.canContinue() && client.stats.requests - start < budget) {
    const batch = legacy.splice(0, 25).filter((record) => sanitizeNameWithOwner(record.name));
    if (!batch.length) continue;
    let data;
    try {
      ({ data } = await client.graphql(repositoriesByName(batch.map((record) => record.name)), {}, { allowPartialErrors: true }));
    } catch (error) {
      if (error?.name === 'GitHubBudgetError') throw error;
      context.log.warn?.(`Legacy resolution batch failed: ${safeErrorMessage(error)}`);
      continue;
    }
    batch.forEach((record, index) => {
      const node = data[`r${index}`];
      // Drop the name-only record; a fresh observation replaces it if valid.
      registry.removeRepository(record.id);
      if (node) {
        ingestRepository(context, node);
        result.resolved += 1;
      } else {
        result.removed += 1;
      }
    });
    await context.persist();
  }
  result.requests = client.stats.requests - start;
  result.backlog = legacy.length;
  return result;
}
