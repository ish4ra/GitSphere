import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Registry, retainAccounts } from '../src/discovery/registry.js';

const at = '2026-11-20T00:00:00Z';
const repo = (id, name, code, stars = 10) => ({
  id, name, stars, forks: 0, owner: { id: `U_${name.split('/')[0]}`, login: name.split('/')[0], type: 'User' },
  attribution: code ? { code, confidence: 'high', evidence: 'explicit-country' } : { code: null, confidence: 'unknown', evidence: 'unrecognized-location' },
  seenAt: at, verifiedAt: at,
});
const user = (id, login, code, extra = {}) => ({
  id, login, type: 'User', followers: 1, publicRepos: 1, location: 'x',
  attribution: code ? { code, confidence: 'high', evidence: 'explicit-country' } : { code: null, confidence: 'ambiguous', evidence: 'ambiguous-place' },
  seenAt: at, sources: ['test'], ...extra,
});

async function registry() {
  return new Registry({ stateDir: await mkdtemp(path.join(os.tmpdir(), 'gitsphere-registry-')) }).load();
}

test('stable node IDs deduplicate renamed repositories', async () => {
  const reg = await registry();
  reg.upsertRepository(repo('R_1', 'old/name', 'LK'));
  reg.upsertRepository(repo('R_1', 'new/name', 'LK', 12));
  assert.deepEqual(reg.repositories('LK').map((item) => item.name), ['new/name']);
  assert.equal(reg.events.renamed, 1);
});

test('a transferred repository moves to its new owner country exactly once', async () => {
  const reg = await registry();
  reg.upsertRepository(repo('R_1', 'a/x', 'LK'));
  reg.upsertRepository(repo('R_1', 'b/x', 'BR'));
  assert.equal(reg.repositories('LK').length, 0);
  assert.equal(reg.repositories('BR').length, 1);
  assert.equal(reg.events.repositoriesMoved, 1);
});

test('an owner location that becomes unattributable removes the repository', async () => {
  const reg = await registry();
  reg.upsertRepository(repo('R_1', 'a/x', 'LK'));
  reg.upsertRepository(repo('R_1', 'a/x', null));
  assert.equal(reg.repositories('LK').length, 0);
  assert.equal(reg.events.repositoriesRemoved, 1);
});

test('legacy name-only records are replaced by the real observation', async () => {
  const reg = await registry();
  reg.importLegacyRepository('LK', { ...repo('ignored', 'Owner/Repo', 'LK'), legacy: true });
  assert.equal(reg.repositories('LK')[0].legacy, true);
  reg.upsertRepository(repo('R_9', 'owner/repo', 'LK'));
  const list = reg.repositories('LK');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'R_9');
  assert.equal(list[0].legacy, undefined);
});

test('accounts move with their location, keep measurements, and organizations are excluded', async () => {
  const reg = await registry();
  reg.upsertAccount(user('U_1', 'dev', 'LK'));
  reg.updateAccount('U_1', { contributions: { public: 500, measuredAt: at } });
  reg.upsertAccount(user('U_1', 'dev-renamed', 'LK', { followers: 3 }));
  assert.equal(reg.account('U_1').login, 'dev-renamed');
  assert.equal(reg.account('U_1').contributions.public, 500);
  reg.upsertAccount(user('U_1', 'dev-renamed', 'JP'));
  assert.equal(reg.accounts('LK').length, 0);
  assert.equal(reg.accounts('JP').length, 1);
  reg.upsertAccount(user('U_1', 'dev-renamed', null));
  assert.equal(reg.account('U_1'), null);
  assert.equal(reg.upsertAccount({ ...user('O_1', 'org', 'LK'), type: 'Organization' }), null);
});

test('retention keeps low-follower, high-activity developers eligible', () => {
  const accounts = [];
  for (let index = 0; index < 50; index += 1) accounts.push(user(`F${index}`, `famous${index}`, 'US', { followers: 10_000 - index, publicRepos: 1 }));
  accounts.push(user('A1', 'active', 'US', { followers: 0, publicRepos: 400 }));
  accounts.push(user('M1', 'measured', 'US', { followers: 0, publicRepos: 0, contributions: { public: 5000 } }));
  const kept = retainAccounts(accounts, { accounts: 30, followersKeep: 10, contributionsKeep: 5, contributionCandidatesKeep: 5 });
  const logins = kept.map((item) => item.login);
  assert.ok(logins.includes('active'));
  assert.ok(logins.includes('measured'));
  assert.ok(logins.includes('famous0'));
});

test('flush persists only bounded, compacted records and reloads them', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gitsphere-registry-'));
  const reg = await new Registry({ stateDir: directory, limits: { repositoryCandidates: 2 } }).load();
  for (let index = 0; index < 5; index += 1) reg.upsertRepository(repo(`R_${index}`, `o/r${index}`, 'LK', index));
  await reg.flush();
  const reloaded = await new Registry({ stateDir: directory }).load();
  assert.deepEqual(reloaded.repositories('LK').map((item) => item.stars), [4, 3]);
});
