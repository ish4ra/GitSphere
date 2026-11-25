#!/usr/bin/env node
// Real GitHub API verification. Runs in CI with the workflow token and
// writes a Markdown report to the job summary. Verification cases are never
// used as ranking inputs.
//
//  1. GraphQL schema descriptions for the contribution fields GitSphere uses.
//  2. Known repositories and accounts: torvalds/linux, microsoft/vscode,
//     torvalds, ish4ra — current public location and shared-resolver result.
//  3. Exact-star bucket recovery: the formerly unresolved `stars:215` bucket is
//     split by creation time until every partition fits the search window.
//  4. Independent discovery: `ish4ra` must be found by location search terms
//     generated for its resolved country, without being added manually.
//  5. Contribution measurement for sample users over the rolling window.
//  6. Discovery terms and resolver behaviour for sample countries.

import { appendFile } from 'node:fs/promises';
import { safeErrorMessage, sanitizeText } from '../src/core/sanitize.js';
import { loadSharedResolver } from '../src/geo/resolver.js';
import { GitHubClient } from '../src/github/client.js';
import { CONTRIBUTIONS, SCHEMA_INTROSPECTION, repositoriesByName } from '../src/github/queries.js';
import { buildQuery, rootPartition, splitPartition } from '../src/discovery/partitions.js';
import { REPOSITORY_SPEC, contributionRecord, contributionWindow, searchAccountsPage, searchRepositoriesPage } from '../src/pipeline/steps.js';
import { locationSpecs } from '../src/discovery/location-scan.js';
import { repositoryFromNode } from '../src/discovery/records.js';

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token) {
  console.log('No token available; live verification skipped.');
  process.exit(0);
}

const client = new GitHubClient({ token, maxRequests: 260, rateLimitReserve: 100 });
const resolver = await loadSharedResolver();
const lines = ['## GitSphere live API verification', ''];
const failures = [];
const check = (condition, message) => {
  lines.push(`- ${condition ? '✅' : '❌'} ${message}`);
  if (!condition) failures.push(message);
};

async function section(title, fn) {
  lines.push(`### ${title}`, '');
  try {
    await fn();
  } catch (error) {
    check(false, `${title} raised: ${safeErrorMessage(error)}`);
  }
  lines.push('');
}

await section('Contribution semantics (live GraphQL schema)', async () => {
  const { data } = await client.graphql(SCHEMA_INTROSPECTION);
  const fields = new Map([...(data.collection?.fields || []), ...(data.calendar?.fields || [])].map((field) => [field.name, field.description]));
  for (const name of ['restrictedContributionsCount', 'totalCommitContributions', 'totalPullRequestReviewContributions', 'totalContributions', 'startedAt', 'endedAt']) {
    lines.push(`- \`${name}\`: ${sanitizeText(fields.get(name), 240) || '(missing)'}`);
  }
  check(fields.has('restrictedContributionsCount') && fields.has('totalContributions'), 'contribution fields used by GitSphere exist in the live schema');
});

await section('Known repositories', async () => {
  const names = ['torvalds/linux', 'microsoft/vscode'];
  const { data } = await client.graphql(repositoriesByName(names));
  names.forEach((name, index) => {
    const node = data[`r${index}`];
    const location = node?.owner?.location || null;
    const result = resolver.resolve(location);
    lines.push(`- **${name}** — ${node?.stargazerCount?.toLocaleString('en-US')} stars, owner location ${JSON.stringify(sanitizeText(location, 80))} → ${result.accepted ? result.countryCode : `not attributed (${result.evidence})`}`);
    check(Boolean(node?.id), `${name} resolved to a stable node ID`);
    // Regression guard for the launch defect: nodes reached only through the
    // shared fragment must carry __typename and be accepted by ingestion.
    check(node?.__typename === 'Repository', `${name} lookup returns __typename "Repository"`);
    check(Boolean(repositoryFromNode(node, { attribution: result, now: new Date().toISOString() })), `${name} is accepted by the production ingestion path`);
  });
});

let ish4ra = null;
await section('Known accounts', async () => {
  const query = `query { ${['torvalds', 'ish4ra'].map((login, index) => `u${index}: user(login: ${JSON.stringify(login)}) { id login location followers { totalCount } repositories(ownerAffiliations: OWNER, privacy: PUBLIC) { totalCount } }`).join(' ')} rateLimit { cost remaining limit resetAt } }`;
  const { data } = await client.graphql(query);
  for (const key of ['u0', 'u1']) {
    const user = data[key];
    const result = resolver.resolve(user?.location);
    lines.push(`- **@${user?.login}** — ${user?.followers?.totalCount} followers, ${user?.repositories?.totalCount} public repos, location ${JSON.stringify(sanitizeText(user?.location, 80))} → ${result.accepted ? `${result.countryCode} (${result.confidence}, ${result.evidence})` : `not attributed (${result.evidence})`}`);
    if (user?.login === 'ish4ra') ish4ra = { ...user, attribution: result };
  }
  check(Boolean(ish4ra), 'ish4ra profile readable');
});

for (const stars of [215, 80]) {
  await section(`Exact-star bucket recovery (stars:${stars})`, async () => {
    const fetchPage = searchRepositoriesPage(client);
    const cycleStartedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    let queue = [{ ...rootPartition({ min: stars, max: stars }) }];
    const leaves = [];
    let requests = 0;
    let rootCount = null;
    while (queue.length && requests < 60) {
      const partition = queue.shift();
      const page = await fetchPage(buildQuery(REPOSITORY_SPEC, partition), null, 1);
      requests += 1;
      rootCount ??= page.count;
      if (page.count > 1000) {
        const split = splitPartition(REPOSITORY_SPEC, partition, cycleStartedAt);
        if (split.children) queue = [...split.children, ...queue];
        else leaves.push({ partition, count: page.count, unresolved: true });
      } else {
        leaves.push({ partition, count: page.count });
      }
    }
    const total = leaves.reduce((sum, leaf) => sum + leaf.count, 0);
    lines.push(`- Unpartitioned query reports ${rootCount?.toLocaleString('en-US')} repositories (window: 1,000). ${requests} count requests → ${leaves.length} creation-time partitions covering ${total.toLocaleString('en-US')} repositories; largest ${Math.max(...leaves.map((leaf) => leaf.count))}.`);
    for (const leaf of leaves.slice(0, 6)) lines.push(`  - \`${buildQuery(REPOSITORY_SPEC, leaf.partition)}\` → ${leaf.count}`);
    if (queue.length) lines.push(`- Stopped at the verification request cap with ${queue.length} partitions queued (the pipeline continues these across runs).`);
    check(leaves.every((leaf) => !leaf.unresolved && leaf.count <= 1000), `every stars:${stars} partition reached fits the 1,000-result window`);
  });
}

await section('Independent discovery of ish4ra', async () => {
  if (!ish4ra?.attribution?.accepted) {
    lines.push(`- ish4ra's current public location does not attribute to a country (${ish4ra?.attribution?.evidence}); not expected in any ranking.`);
    return;
  }
  const code = ish4ra.attribution.countryCode;
  const terms = resolver.discoveryTerms(code);
  const fetchPage = searchAccountsPage(client);
  let found = null;
  let requests = 0;
  for (const term of terms) {
    if (requests >= 60) break;
    const spec = locationSpecs(term)[0].spec;
    const followers = ish4ra.followers.totalCount;
    // Search the follower bucket that contains the account, as the
    // partitioned scan eventually does for every bucket.
    const page = await fetchPage(buildQuery(spec, { metric: [followers, followers], created: null }), null, 100);
    requests += 1;
    if (page.nodes.some((node) => node?.login === 'ish4ra')) {
      found = term;
      break;
    }
  }
  lines.push(`- Country ${code}: ${terms.length} discovery terms; searched ${requests}.`);
  check(Boolean(found), found ? `ish4ra discovered via generated term ${JSON.stringify(found)}` : 'ish4ra discovered by generated location terms');
});

await section('Public contributions (rolling 12 months)', async () => {
  const window = contributionWindow(new Date().toISOString());
  const idQuery = 'query { a: user(login: "torvalds") { id } b: user(login: "ish4ra") { id } rateLimit { cost remaining limit resetAt } }';
  const ids = (await client.graphql(idQuery)).data;
  const { data } = await client.graphql(CONTRIBUTIONS, { ids: [ids.a.id, ids.b.id], ...window });
  for (const node of data.nodes) {
    const collection = node.contributionsCollection;
    const record = contributionRecord(collection, new Date().toISOString());
    // Private (restricted) counts are used only for the invariant check and
    // are never printed or stored.
    lines.push(`- **@${node.login}**: public contributions ${record.public} (commits ${record.commits}, PRs ${record.pullRequests}, reviews ${record.reviews}, issues ${record.issues}); window ${record.from} → ${record.to}`);
    check(record.public <= (collection.contributionCalendar?.totalContributions || 0), `@${node.login} public contributions never exceed the calendar total`);
    check(!('restricted' in record) && !('calendarTotal' in record), `@${node.login} record holds no private contribution counts`);
  }
});

await section('Sample countries', async () => {
  for (const code of ['LK', 'US', 'CN', 'DE', 'JP', 'IN', 'MV', 'TV', 'XK']) {
    const terms = resolver.discoveryTerms(code);
    lines.push(`- **${code}**: ${terms.length} discovery terms (first: ${terms.slice(0, 5).map((term) => JSON.stringify(term)).join(', ')})`);
  }
});

lines.push(`API usage: ${client.stats.requests} requests, ${client.stats.pointsUsed} points, ${client.stats.remaining ?? '—'} remaining of ${client.stats.limit ?? '—'}.`, '');
lines.push(failures.length ? `**${failures.length} check(s) failed.**` : '**All live checks passed.**');
const report = lines.join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
if (failures.length) process.exitCode = 1;
