// Publication: machine-readable datasets, country pages, per-mode
// directories, data/summary.json and the root README. Content timestamps
// move only when the published ranking content actually changes, so
// unchanged countries do not create commit churn.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { COUNTRIES } from '../countries.js';
import { listCodes, readJson, writeJson, writeText } from '../core/store.js';
import { metricCertification } from '../discovery/metric-scan.js';
import { buildRankings, RANKING_METHODOLOGY_VERSION, statusCounts } from '../rankings/build.js';
import { avatarUrl, isoDate, MODE_META, profileUrl, repositoryUrl } from './format.js';
import { renderCountryPage, renderDirectory } from './pages.js';
import { renderRootReadme } from './readme.js';

// Slugs used by earlier releases; kept as redirect pages for old links.
export const LEGACY_SLUGS = new Map([
  ['falkland-islands-islas-malvinas', 'FK'],
  ['hong-kong-sar-china', 'HK'],
  ['macao-sar-china', 'MO'],
]);

export async function publishAll({ root, stateDir, registry, ownerCandidates, now, report = null }) {
  const timestamp = now();
  const repositoryScan = await readJson(path.join(stateDir, 'repositories', 'scan.json'), null);
  const followerScan = await readJson(path.join(stateDir, 'users', 'scan.json'), null);
  const locationStates = new Map();
  for (const code of await listCodes(path.join(stateDir, 'locations'))) {
    locationStates.set(code, await readJson(path.join(stateDir, 'locations', `${code}.json`), null));
  }
  const pendingOwners = new Map(COUNTRIES.map((country) => [country.code, ownerCandidates?.pending(country.code) || 0]));

  const rankings = buildRankings({
    registry,
    repositoryCertification: metricCertification(repositoryScan, { now: timestamp }),
    followerCertification: metricCertification(followerScan, { now: timestamp }),
    locationStates,
    pendingOwners,
    now: timestamp,
  });

  const changed = { data: 0, pages: 0 };
  const summaries = {};
  for (const mode of ['repositories', 'developers', 'contributors']) {
    const perCountry = new Map();
    for (const country of COUNTRIES) {
      const ranking = rankings[mode].get(country.code);
      const dataPath = path.join(root, MODE_META[mode].data(country.code));
      const previous = await readJson(dataPath, null);
      const document = toDataDocument(ranking, previous, timestamp);
      if (await writeJson(dataPath, document)) changed.data += 1;
      perCountry.set(country.code, { updatedAt: document.updatedAt, verifiedOn: document.verifiedOn });
      const page = renderCountryPage(ranking, { verifiedOn: document.verifiedOn });
      if (await writeText(path.join(root, MODE_META[mode].page(country.slug)), `${page}\n`)) changed.pages += 1;
    }
    if (await writeText(path.join(root, MODE_META[mode].directory), `${renderDirectory(mode, rankings[mode], { summary: perCountry })}\n`)) {
      changed.pages += 1;
    }
    summaries[mode] = {
      counts: statusCounts(rankings[mode]),
      entries: [...rankings[mode].values()].reduce((sum, ranking) => sum + ranking.entries.length, 0),
      countriesWithResults: [...rankings[mode].values()].filter((ranking) => ranking.entries.length).length,
      countries: Object.fromEntries(
        [...rankings[mode].values()].map((ranking) => [ranking.country.code, {
          status: ranking.status,
          entries: ranking.entries.length,
          updatedAt: perCountry.get(ranking.country.code).updatedAt,
        }]),
      ),
    };
  }

  const summaryPath = path.join(root, 'data', 'summary.json');
  const previousSummary = await readJson(summaryPath, null);
  const apiRun = Boolean(report && !report.api?.skipped && (report.api?.requests || 0) > 0);
  // Discard any earlier record of a run that made no API requests.
  const previousRun = previousSummary?.lastRun?.requests > 0 ? previousSummary.lastRun : null;
  const previousSuccess = previousRun ? previousSummary.lastSuccessfulRefresh || null : null;
  const summary = {
    schemaVersion: 3,
    methodologyVersion: RANKING_METHODOLOGY_VERSION,
    generatedAt: timestamp,
    scans: {
      repositories: scanSummary(repositoryScan, timestamp),
      followers: scanSummary(followerScan, timestamp),
      locations: {
        countriesStarted: locationStates.size,
        countriesWithCompletedRound: [...locationStates.values()].filter((state) => state?.completedRounds?.length).length,
      },
    },
    // Only real API runs count as a refresh. Offline publication or
    // migration never updates these fields.
    lastRun: apiRun ? {
      startedAt: report.startedAt,
      requests: report.api.requests,
      progress: report.progress?.reason || null,
      ok: Boolean(report.progress?.ok),
      stopReason: report.stopReason,
      failures: report.failures.length,
    } : previousRun,
    lastSuccessfulRefresh: apiRun && report.progress?.ok ? report.startedAt : previousSuccess,
    modes: summaries,
  };
  // Avoid rewriting the summary when only the run timestamp changed.
  const comparable = (value) => JSON.stringify({ ...value, generatedAt: null });
  if (!previousSummary || comparable(previousSummary) !== comparable(summary) || apiRun) {
    await writeJson(summaryPath, summary, { compact: false });
  }
  if (await writeText(path.join(root, 'README.md'), `${renderRootReadme(summary)}\n`)) changed.pages += 1;
  for (const [slug, code] of LEGACY_SLUGS) {
    const country = COUNTRIES.find((item) => item.code === code);
    const stub = [
      `# ${country.flag} ${country.name}`,
      '',
      `This page has moved. See **[${country.name} — Top Repositories](./${country.slug}.md)**, or browse [Top Developers](./developers/${country.slug}.md) and [Top Contributors](./contributors/${country.slug}.md).`,
      '',
    ].join('\n');
    if (await writeText(path.join(root, 'rankings', `${slug}.md`), stub)) changed.pages += 1;
  }

  return {
    changed,
    counts: Object.fromEntries(Object.entries(summaries).map(([mode, value]) => [mode, value.counts])),
    entries: Object.fromEntries(Object.entries(summaries).map(([mode, value]) => [mode, value.entries])),
  };
}

function scanSummary(state, now) {
  if (!state) return { cycle: 0, verifiedFloor: null };
  const certification = metricCertification(state, { now });
  return {
    cycle: state.cycle,
    floor: state.floor,
    queue: state.queue?.length || 0,
    unresolved: state.unresolved?.length || 0,
    pages: state.stats?.pages || 0,
    nodes: state.stats?.nodes || 0,
    completedCycles: state.completedCycles?.length || 0,
    verifiedFloor: certification.verifiedFloor,
    basis: certification.basis,
  };
}

export function toDataDocument(ranking, previous, timestamp) {
  const entries = ranking.entries.map((entry, index) => publicEntry(ranking.mode, entry, index + 1));
  const core = {
    schemaVersion: 3,
    mode: ranking.mode,
    methodologyVersion: RANKING_METHODOLOGY_VERSION,
    country: { code: ranking.country.code, name: ranking.country.name, slug: ranking.country.slug },
    status: ranking.status,
    source: {
      provider: 'GitHub GraphQL API',
      countryBasis: ranking.mode === 'repositories'
        ? 'public profile location of the repository owner'
        : 'public profile location of the user',
    },
    coverage: publicCoverage(ranking),
    [ranking.mode === 'repositories' ? 'repositories' : 'users']: entries,
  };
  const hash = createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 16);
  const unchanged = previous?.contentHash === hash;
  return {
    ...core,
    contentHash: hash,
    updatedAt: unchanged ? previous.updatedAt : timestamp,
    verifiedOn: isoDate(ranking.oldestVerification),
    // Backward compatibility with the pre-GitSphere schema.
    generatedAt: unchanged ? previous.generatedAt || previous.updatedAt : timestamp,
  };
}

function publicCoverage(ranking) {
  // Global scan progress lives in data/summary.json only, so a moving global
  // frontier does not rewrite every country's dataset on every run.
  const { location, starScan, followerScan, verifiedStarFloor, verifiedFollowerFloor, ...rest } = ranking.coverage;
  return {
    ...rest,
    location: location
      ? { complete: location.complete, completeWithoutGaps: location.completeWithoutGaps, round: location.round, termIndex: location.termIndex, terms: location.terms, unresolved: location.unresolved }
      : undefined,
    exhaustive: false,
  };
}

function publicEntry(mode, entry, rank) {
  if (mode === 'repositories') {
    return {
      rank,
      id: entry.legacy ? null : entry.id,
      name: entry.name.split('/')[1],
      nameWithOwner: entry.name,
      url: repositoryUrl(entry.name),
      description: entry.description || null,
      stars: entry.stars,
      forks: entry.forks,
      primaryLanguage: entry.language || null,
      license: entry.license ? { spdxId: entry.license } : null,
      createdAt: entry.createdAt || null,
      pushedAt: entry.pushedAt || null,
      archived: Boolean(entry.archived),
      owner: {
        login: entry.owner?.login,
        name: entry.owner?.name || null,
        type: entry.owner?.type || null,
        url: profileUrl(entry.owner?.login),
        location: entry.owner?.location || null,
        attribution: entry.attribution ? { confidence: entry.attribution.confidence, evidence: entry.attribution.evidence } : null,
      },
      verifiedOn: isoDate(entry.revalidatedAt || entry.verifiedAt || entry.seenAt),
      ...(entry.legacy ? { pendingRevalidation: true } : {}),
    };
  }
  const base = {
    rank,
    id: entry.id,
    login: entry.login,
    name: entry.name || null,
    url: profileUrl(entry.login),
    avatarUrl: avatarUrl(entry, 40),
    followers: entry.followers,
    publicRepos: entry.publicRepos,
    location: entry.location || null,
    attribution: entry.attribution ? { confidence: entry.attribution.confidence, evidence: entry.attribution.evidence } : null,
    verifiedOn: isoDate(entry.seenAt),
  };
  if (mode === 'contributors') {
    const c = entry.contributions;
    return {
      ...base,
      contributions: {
        public: c.public,
        commits: c.commits,
        pullRequests: c.pullRequests,
        reviews: c.reviews,
        issues: c.issues,
        repositories: c.repositories,
        windowFrom: c.from,
        windowTo: c.to,
        measuredOn: isoDate(c.measuredAt),
      },
    };
  }
  return base;
}
