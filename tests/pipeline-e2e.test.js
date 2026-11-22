import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, runPipeline } from '../src/pipeline/run.js';
import { createFakeGitHub, noSleep } from './helpers/fake-github.js';

// End-to-end: real pipeline, real resolver and gazetteer, real publication,
// against an in-memory GitHub that enforces search-window semantics.

const quiet = { info() {}, warn() {}, error() {} };
const settings = {
  ...DEFAULT_SETTINGS,
  maxRequests: 4000,
  rateLimitReserve: 50,
  repositoryStarFloor: 50,
  followerFloor: 100,
  locationSlice: 400,
  locationCountries: ['LK', 'BR', 'US', 'TV'],
  repositoryRevalidateHours: 0,
  accountRefreshHours: 0,
  budgets: { repositories: 400, legacy: 20, locations: 2000, followers: 200, owners: 20, revalidation: 50, accounts: 50, contributions: 50 },
};

function fixture() {
  const users = [
    { id: 'U_kal', login: 'kalutara-dev', location: 'Kalutara South, Srilanka', followers: 12, publicRepos: 40, createdAt: '2017-01-01T00:00:00Z', contributions: { calendar: 900, restricted: 100, commits: 600 } },
    { id: 'U_low', login: 'quiet-builder', location: 'Gampaha, Sri Lanka', followers: 0, publicRepos: 80, createdAt: '2019-01-01T00:00:00Z', contributions: { calendar: 3000, restricted: 0, commits: 2500 } },
    { id: 'U_fam', login: 'famous-lk', location: 'Colombo, Sri Lanka', followers: 5000, publicRepos: 10, createdAt: '2012-01-01T00:00:00Z', contributions: { calendar: 50, restricted: 0 } },
    { id: 'U_br', login: 'colombo-br', location: 'Colombo-PR, Brazil', followers: 300, publicRepos: 5, createdAt: '2015-01-01T00:00:00Z' },
    { id: 'U_pdx', login: 'pdx', location: 'Portland, OR', followers: 900, publicRepos: 9, createdAt: '2011-01-01T00:00:00Z' },
    { id: 'U_amb', login: 'ambiguous', location: 'Portland', followers: 800, publicRepos: 9, createdAt: '2011-01-01T00:00:00Z' },
    { id: 'U_moon', login: 'spaceman', location: 'The Moon', followers: 700, publicRepos: 3, createdAt: '2013-01-01T00:00:00Z' },
    { id: 'O_lk', login: 'lk-org', type: 'Organization', location: 'Sri Lanka', followers: 0, publicRepos: 3, createdAt: '2016-01-01T00:00:00Z' },
  ];
  for (let index = 0; index < 30; index += 1) {
    users.push({ id: `U_us${index}`, login: `us-dev-${index}`, location: 'San Francisco, CA', followers: 150 + index * 37, publicRepos: 5, createdAt: '2014-01-01T00:00:00Z' });
  }
  const repositories = [
    { id: 'R_us', owner: 'pdx', name: 'big-tool', stars: 40000, createdAt: '2015-01-01T00:00:00Z' },
    { id: 'R_amb', owner: 'ambiguous', name: 'popular', stars: 30000, createdAt: '2015-01-01T00:00:00Z' },
    { id: 'R_fam', owner: 'famous-lk', name: 'framework', stars: 9000, createdAt: '2014-01-01T00:00:00Z' },
    { id: 'R_kal', owner: 'kalutara-dev', name: 'small-lib', stars: 7, createdAt: '2020-01-01T00:00:00Z' },
    { id: 'R_kal2', owner: 'kalutara-dev', name: 'second-lib', stars: 5, createdAt: '2021-01-01T00:00:00Z' },
    { id: 'R_org', owner: 'lk-org', name: 'org-project', stars: 30, createdAt: '2018-01-01T00:00:00Z' },
    { id: 'R_fork', owner: 'famous-lk', name: 'forked', stars: 99999, fork: true, createdAt: '2014-01-01T00:00:00Z' },
    { id: 'R_br', owner: 'colombo-br', name: 'br-app', stars: 120, createdAt: '2016-01-01T00:00:00Z' },
  ];
  // An exact-star bucket larger than the search window, owned by US users.
  for (let index = 0; index < 1300; index += 1) {
    repositories.push({ id: `R_b${index}`, owner: `us-dev-${index % 30}`, name: `bucket-${index}`, stars: 215, createdAt: new Date(Date.parse('2010-01-01T00:00:00Z') + index * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  }
  return { users, repositories };
}

async function run(root, fake, now) {
  return runPipeline({ root, token: 'test', settings, fetchImpl: fake.fetchImpl, now: () => now, log: quiet, clientOptions: { sleep: noSleep, minimumIntervalMs: 0 } });
}

const json = async (root, file) => JSON.parse(await readFile(path.join(root, file), 'utf8'));

test('full pipeline: discovery, attribution, three rankings, refresh and publication', { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitsphere-e2e-'));
  const fake = createFakeGitHub(fixture());
  const report = await run(root, fake, '2026-11-20T00:00:00.000Z');

  assert.equal(report.failures.length, 0, JSON.stringify(report.failures));
  assert.ok(report.progress.ok, report.progress.reason);

  const scan = await json(root, 'state/repositories/scan.json');
  assert.equal(scan.unresolved.length, 0, 'exact-star bucket recovered by creation-time partitions');

  const us = await json(root, 'data/US.json');
  assert.ok(us.repositories.some((repo) => repo.nameWithOwner === 'pdx/big-tool'), 'Portland, OR → US');
  assert.equal(us.repositories.filter((repo) => repo.stars === 215).length, 99);
  const all = await Promise.all(['US', 'LK', 'BR', 'AU', 'JM', 'GB'].map((code) => json(root, `data/${code}.json`)));
  assert.ok(all.every((doc) => !doc.repositories.some((repo) => repo.nameWithOwner === 'ambiguous/popular')), 'ambiguous "Portland" never attributed');
  assert.ok(all.every((doc) => !doc.repositories.some((repo) => repo.name === 'forked')), 'forks excluded');

  const lk = await json(root, 'data/LK.json');
  const lkNames = lk.repositories.map((repo) => repo.nameWithOwner);
  assert.deepEqual(lkNames, ['famous-lk/framework', 'lk-org/org-project', 'kalutara-dev/small-lib', 'kalutara-dev/second-lib'], 'small-country ranking incl. owner expansion');
  assert.ok(['published', 'provisional'].includes(lk.status));

  const developers = await json(root, 'data/developers/LK.json');
  assert.deepEqual(developers.users.map((user) => user.login), ['famous-lk', 'kalutara-dev', 'quiet-builder'], 'followers ranking, organizations excluded');
  assert.equal(developers.users[1].location, 'Kalutara South, Srilanka');

  const contributors = await json(root, 'data/contributors/LK.json');
  assert.deepEqual(contributors.users.map((user) => user.login), ['quiet-builder', 'kalutara-dev', 'famous-lk'], 'independent contributions ranking');
  assert.equal(contributors.users[1].contributions.public, 800, 'calendar total minus restricted');
  assert.equal(contributors.users[0].followers, 0, 'zero-follower developer still ranked');

  const br = await json(root, 'data/developers/BR.json');
  assert.deepEqual(br.users.map((user) => user.login), ['colombo-br']);

  const summary = await json(root, 'data/summary.json');
  for (const mode of ['repositories', 'developers', 'contributors']) {
    const counts = summary.modes[mode].counts;
    const sum = ['published', 'provisional', 'building', 'stale', 'empty', 'blocked'].reduce((total, key) => total + counts[key], 0);
    assert.equal(sum, 250, `${mode} statuses sum to 250`);
    assert.equal(counts.total, 250);
  }
  assert.equal(summary.modes.developers.countries.TV.status, 'empty', 'no attributable results after complete discovery');

  // Pages, cross-links and directories.
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  for (const link of ['./rankings/README.md', './rankings/developers/README.md', './rankings/contributors/README.md']) {
    assert.ok(readme.includes(`href="${link}"`), link);
    assert.ok(existsSync(path.join(root, link)), `${link} exists`);
  }
  const page = await readFile(path.join(root, 'rankings/sri-lanka.md'), 'utf8');
  assert.ok(page.includes('href="./developers/sri-lanka.md"') && page.includes('href="./contributors/sri-lanka.md"'));
  const developerPage = await readFile(path.join(root, 'rankings/developers/sri-lanka.md'), 'utf8');
  assert.ok(developerPage.includes('href="../sri-lanka.md"') && developerPage.includes('href="../contributors/sri-lanka.md"'));
  assert.ok(developerPage.includes('kalutara-dev'));
  const directory = await readFile(path.join(root, 'rankings/developers/README.md'), 'utf8');
  assert.equal((directory.match(/\]\(\.\/[a-z0-9-]+\.md\)/g) || []).length, 250, 'directory links every country');

  // ---- Second run: GitHub changed underneath us. ----
  fake.repos.get('R_fam').name = 'framework-renamed';
  fake.repos.get('R_br').owner = 'famous-lk'; // transferred BR -> LK owner
  fake.repos.get('R_org').deleted = true;
  fake.accounts.get('U_kal').location = 'Tokyo, Japan';
  fake.accounts.get('U_low').deleted = true;
  const updatedAtBefore = (await json(root, 'data/TV.json')).updatedAt;

  const second = await run(root, fake, '2026-11-21T00:00:00.000Z');
  assert.equal(second.failures.length, 0, JSON.stringify(second.failures));
  const lk2 = (await json(root, 'data/LK.json')).repositories.map((repo) => repo.nameWithOwner);
  assert.ok(lk2.includes('famous-lk/framework-renamed') && !lk2.includes('famous-lk/framework'), 'rename followed by node ID');
  assert.ok(lk2.includes('famous-lk/br-app'), 'transfer re-attributed');
  assert.ok(!lk2.includes('lk-org/org-project'), 'deleted repository removed');
  assert.ok(!(await json(root, 'data/BR.json')).repositories.some((repo) => repo.name === 'br-app'));
  const dev2 = (await json(root, 'data/developers/LK.json')).users.map((user) => user.login);
  assert.ok(!dev2.includes('kalutara-dev') && !dev2.includes('quiet-builder'), 'relocated and deleted users removed');
  assert.ok((await json(root, 'data/developers/JP.json')).users.some((user) => user.login === 'kalutara-dev'), 'relocated user moved');
  assert.equal((await json(root, 'data/TV.json')).updatedAt, updatedAtBefore, 'unchanged rankings keep their timestamp');
});
