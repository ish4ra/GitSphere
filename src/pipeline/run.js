// GitSphere pipeline orchestrator: one process, one data writer.
//
// Steps run in a fixed order with individual API budgets. A budget or rate
// limit stop ends the API phase cleanly; everything already ingested is
// checkpointed and publication still runs. The run report distinguishes
// useful work from a successful no-op so automation can surface stalls.

import path from 'node:path';
import { readJson, writeJson } from '../core/store.js';
import { safeErrorMessage } from '../core/sanitize.js';
import { loadSharedResolver } from '../geo/resolver.js';
import { GitHubClient } from '../github/client.js';
import { Registry } from '../discovery/registry.js';
import { OwnerCandidates } from '../discovery/owners.js';
import {
  accountRefreshStep,
  contributionStep,
  followerScanStep,
  legacyResolutionStep,
  locationScanStep,
  ownerExpansionStep,
  repositoryRevalidationStep,
  repositoryScanStep,
} from './steps.js';
import { publishAll } from '../publish/publish.js';
import { evaluateHealth } from './health.js';

export const DEFAULT_SETTINGS = Object.freeze({
  maxRequests: 900,
  rateLimitReserve: 300,
  runtimeMinutes: 42,
  repositoryStarFloor: 50,
  followerFloor: 100,
  locationSlice: 6,
  locationRefreshDays: 14,
  ownerExpansionDays: 30,
  repositoryRevalidateHours: 72,
  accountRefreshHours: 168,
  contributionRefreshDays: 7,
  contributionBatch: 20,
  locationCountries: [],
  budgets: {
    repositories: 280,
    followers: 120,
    locations: 240,
    legacy: 60,
    owners: 40,
    revalidation: 60,
    accounts: 40,
    contributions: 80,
  },
});

/**
 * Deadline for step `index`: its share of the remaining runtime in
 * proportion to its request budget among this and all later steps. Time a
 * step leaves unused flows to the steps after it.
 */
export function stepDeadline({ now, runtimeEnd, budgets, names, index }) {
  const budget = budgets[names[index]] ?? 0;
  const remainingBudget = names.slice(index).reduce((sum, name) => sum + (budgets[name] ?? 0), 0);
  return now + Math.max(0, runtimeEnd - now) * (budget / Math.max(1, remainingBudget));
}

export function settingsFromEnv(env = process.env) {
  const int = (name, fallback, min, max) => {
    const value = Number.parseInt(env[name] ?? '', 10);
    return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const d = DEFAULT_SETTINGS;
  return {
    ...d,
    maxRequests: int('GITSPHERE_MAX_REQUESTS', d.maxRequests, 0, 5000),
    rateLimitReserve: int('GITSPHERE_RATE_LIMIT_RESERVE', d.rateLimitReserve, 50, 2000),
    runtimeMinutes: int('GITSPHERE_RUNTIME_MINUTES', d.runtimeMinutes, 1, 330),
    repositoryStarFloor: int('GITSPHERE_STAR_FLOOR', d.repositoryStarFloor, 1, 100000),
    followerFloor: int('GITSPHERE_FOLLOWER_FLOOR', d.followerFloor, 1, 100000),
    locationCountries: (env.GITSPHERE_LOCATION_COUNTRIES || '').split(',').map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code)),
    budgets: Object.fromEntries(
      Object.entries(d.budgets).map(([key, value]) => [key, int(`GITSPHERE_BUDGET_${key.toUpperCase()}`, value, 0, 5000)]),
    ),
  };
}

export async function runPipeline({
  root,
  token,
  settings = settingsFromEnv(),
  fetchImpl,
  now = () => new Date().toISOString(),
  log = console,
  skipApi = false,
  clientOptions = {},
}) {
  const startedAtMs = Date.now();
  const stateDir = path.join(root, 'state');
  const resolver = await loadSharedResolver();
  const registry = await new Registry({ stateDir, now }).load();
  const ownerCandidates = await new OwnerCandidates(stateDir).load();
  const report = {
    schemaVersion: 3,
    startedAt: now(),
    finishedAt: null,
    stopReason: null,
    steps: {},
    failures: [],
    counters: {
      repositoriesSeen: 0,
      repositoriesAttributed: 0,
      ambiguousLocations: 0,
      unknownLocations: 0,
      accountsSeen: 0,
      accountsAttributed: 0,
    },
  };

  let lastPersist = 0;
  const context = {
    root,
    stateDir,
    resolver,
    registry,
    ownerCandidates,
    settings,
    now,
    log,
    counters: report.counters,
    client: null,
    stepDeadline: Infinity,
    canContinue: () =>
      !report.stopReason &&
      Date.now() - startedAtMs < settings.runtimeMinutes * 60_000 &&
      Date.now() < context.stepDeadline &&
      context.client.canSpend(),
    async persist(write, { force = false } = {}) {
      if (!force && Date.now() - lastPersist < 15_000) return;
      lastPersist = Date.now();
      await registry.flush();
      await ownerCandidates.save();
      if (write) await write();
    },
  };

  if (!skipApi && settings.maxRequests > 0) {
    context.client = new GitHubClient({
      token,
      fetchImpl,
      maxRequests: settings.maxRequests,
      rateLimitReserve: settings.rateLimitReserve,
      log,
      ...clientOptions,
    });
    const steps = [
      ['repositories', repositoryScanStep],
      ['legacy', legacyResolutionStep],
      ['locations', locationScanStep],
      ['followers', followerScanStep],
      ['owners', ownerExpansionStep],
      ['revalidation', repositoryRevalidationStep],
      ['accounts', accountRefreshStep],
      ['contributions', contributionStep],
    ];
    const runtimeEnd = startedAtMs + settings.runtimeMinutes * 60_000;
    for (const [index, [name, step]] of steps.entries()) {
      const budget = settings.budgets[name] ?? 0;
      if (!budget || report.stopReason) continue;
      // Each step gets a share of the remaining runtime proportional to its
      // request budget, so slow early steps cannot starve later ones.
      context.stepDeadline = stepDeadline({ now: Date.now(), runtimeEnd, budgets: settings.budgets, names: steps.map(([other]) => other), index });
      if (!context.canContinue()) {
        if (Date.now() >= runtimeEnd) {
          report.stopReason = 'runtime-budget';
          break;
        }
        if (context.client.stopReason()) {
          report.stopReason = context.client.stopReason();
          break;
        }
        continue;
      }
      const stepStart = Date.now();
      try {
        report.steps[name] = { ...(await step(context, budget)), seconds: Math.round((Date.now() - stepStart) / 1000) };
        log.info?.(`[${name}] ${JSON.stringify(report.steps[name])}`);
      } catch (error) {
        if (error?.name === 'GitHubBudgetError') {
          report.stopReason = error.reason;
          report.steps[name] = { stopped: error.reason, seconds: Math.round((Date.now() - stepStart) / 1000) };
          log.warn?.(`[${name}] stopped: ${error.reason}`);
        } else {
          report.failures.push({ step: name, error: safeErrorMessage(error) });
          report.steps[name] = { failed: true, seconds: Math.round((Date.now() - stepStart) / 1000) };
          log.error?.(`[${name}] failed: ${safeErrorMessage(error)}`);
        }
      }
      context.stepDeadline = Infinity;
      await context.persist(null, { force: true });
    }
    report.api = { ...context.client.stats };
  } else {
    report.api = { requests: 0, skipped: true };
  }

  await registry.flush();
  await ownerCandidates.save();
  report.registryEvents = { ...registry.events };
  // Progress is assessed before publication so that only a run that made
  // real progress is ever labelled as a successful refresh.
  report.health = evaluateHealth({
    repositoryScan: await readJson(path.join(stateDir, 'repositories', 'scan.json'), null),
    followerScan: await readJson(path.join(stateDir, 'users', 'scan.json'), null),
    now: now(),
  });
  report.progress = assessProgress(report, settings, skipApi);
  report.publication = await publishAll({ root, stateDir, registry, ownerCandidates, now, report });
  report.finishedAt = now();
  report.runtimeSeconds = Math.round((Date.now() - startedAtMs) / 1000);
  await writeJson(path.join(stateDir, 'run.json'), report, { compact: false });
  return report;
}

/**
 * A run with API budget available that made no requests, or that made
 * requests but advanced nothing, is reported as a stall rather than success.
 */
export function assessProgress(report, settings, skipApi) {
  if (skipApi || settings.maxRequests === 0) return { ok: true, reason: 'api-skipped' };
  const requests = report.api?.requests || 0;
  const rateLimited = ['primary-rate-limit', 'secondary-rate-limit', 'rate-limit-reserve'].includes(report.stopReason);
  if (report.failures.length) return { ok: false, reason: 'step-failures' };
  // Nodes that cannot be ingested mean a query/schema mismatch; silently
  // discarding them is how data was lost before, so it is a hard failure.
  if ((report.counters?.malformedRepositoryNodes || 0) > 0) return { ok: false, reason: 'malformed-repository-nodes' };
  if (Object.values(report.steps).some((step) => (step.malformed || 0) > 0)) return { ok: false, reason: 'malformed-repository-nodes' };
  if (requests === 0 && !rateLimited) return { ok: false, reason: 'no-api-requests-with-budget-available' };
  const advanced = Object.values(report.steps).some((step) =>
    (step.pages || 0) + (step.checked || 0) + (step.measured || 0) + (step.ownersExpanded || 0) + (step.resolved || 0) + (step.removed || 0) > 0,
  );
  if (!advanced && !rateLimited) return { ok: false, reason: 'requests-without-progress' };
  if (!rateLimited) {
    // Perpetual scans always have work; any step with a backlog must spend.
    for (const [name, step] of Object.entries(report.steps)) {
      if (step.stopped || step.failed) continue;
      // Global scans always have work (a finished cycle starts the next);
      // other steps are idle only if they had a backlog.
      const perpetual = ['repositories', 'followers'].includes(name);
      if ((step.requests || 0) === 0 && (perpetual || (step.backlog || 0) > 0)) {
        return { ok: false, reason: `idle-step:${name}` };
      }
    }
  }
  if (report.health && !report.health.ok) return { ok: false, reason: `health:${report.health.issues[0]}` };
  return { ok: true, reason: rateLimited ? 'rate-limited-after-progress' : 'progress' };
}

export async function readRunReport(root) {
  return readJson(path.join(root, 'state', 'run.json'), null);
}
