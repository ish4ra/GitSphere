import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../src/github/client.js';

function respond(status, body, headers = {}) {
  return { status, ok: status < 300, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, json: async () => body };
}
const ok = (remaining = 4000) => respond(200, { data: { value: 1, rateLimit: { cost: 1, remaining, limit: 5000 } } });

function client(responses, options = {}) {
  const slept = [];
  const instance = new GitHubClient({
    token: 'test-token',
    fetchImpl: async () => responses.shift() || ok(),
    sleep: async (ms) => slept.push(ms),
    minimumIntervalMs: 0,
    ...options,
  });
  return { instance, slept };
}

test('secondary rate limits honour retry-after and then succeed', async () => {
  const { instance, slept } = client([respond(403, { message: 'You have exceeded a secondary rate limit' }, { 'retry-after': '7' }), ok()]);
  const { data } = await instance.graphql('query { x }');
  assert.equal(data.value, 1);
  assert.deepEqual(slept, [7000]);
});

test('persistent secondary limits stop safely with a budget error', async () => {
  const limited = () => respond(429, { message: 'secondary rate limit' }, { 'retry-after': '120' });
  const { instance } = client([limited(), limited(), limited(), limited()], { maxSecondaryWaitMs: 200_000 });
  await assert.rejects(instance.graphql('query { x }'), (error) => error.name === 'GitHubBudgetError' && error.reason === 'secondary-rate-limit');
});

test('primary rate-limit exhaustion is not retried', async () => {
  const { instance } = client([respond(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' })]);
  await assert.rejects(instance.graphql('query { x }'), (error) => error.reason === 'primary-rate-limit');
});

test('transient 5xx failures are retried with backoff', async () => {
  const { instance, slept } = client([respond(502, {}), respond(503, {}), ok()]);
  await instance.graphql('query { x }');
  assert.equal(slept.length, 2);
  assert.equal(instance.stats.retries, 2);
});

test('the rate-limit reserve and request budget are enforced before spending', async () => {
  const { instance } = client([ok(150)], { rateLimitReserve: 200, maxRequests: 10 });
  await instance.graphql('query { x }');
  assert.equal(instance.canSpend(), false);
  assert.equal(instance.stopReason(), 'rate-limit-reserve');
  await assert.rejects(instance.graphql('query { x }'), (error) => error.reason === 'rate-limit-reserve');
  const capped = client([], { maxRequests: 1 }).instance;
  await capped.graphql('query { x }');
  await assert.rejects(capped.graphql('query { x }'), (error) => error.reason === 'request-budget');
});

test('NOT_FOUND errors are tolerated only when partial results are allowed', async () => {
  const partial = () => respond(200, { data: { nodes: [null], rateLimit: { cost: 1, remaining: 4000 } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }] });
  const { instance } = client([partial(), partial()]);
  const { data } = await instance.graphql('query { nodes }', {}, { allowPartialErrors: true });
  assert.deepEqual(data.nodes, [null]);
  await assert.rejects(instance.graphql('query { nodes }'), /GitHub GraphQL error/);
});

test('error messages never echo credential-shaped content', async () => {
  const leaked = ['gh', 'p_', 'Z'.repeat(36)].join('');
  const { instance } = client([respond(400, { message: `bad request ${leaked}` })]);
  await assert.rejects(instance.graphql('query { x }'), (error) => !error.message.includes(leaked) && error.message.includes('[redacted]'));
});
