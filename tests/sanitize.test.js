import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertNoSecrets, detectSecrets, redactSecrets, sanitizeText, sanitizeUrl } from '../src/core/sanitize.js';
import { writeJson } from '../src/core/store.js';
import { repositoryFromNode } from '../src/discovery/records.js';

// Credential-shaped fixtures are assembled at runtime so this file itself
// never contains a literal that push protection would flag.
const fake = {
  githubClassic: ['gh', 'p_', 'a1B2'.repeat(9)].join(''),
  githubFineGrained: ['github', '_pat_', '11AAAA', 'b'.repeat(70)].join(''),
  aws: ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join(''),
  slack: ['xo', 'xb-', '1234567890-abcdefghij'].join(''),
  jwt: ['ey', 'J', 'hbGciOiJIUzI1NiJ9', '.', 'ey', 'J', 'zdWIiOiIxMjM0NSJ9', '.', 'abcdefghijKLMNOP'].join(''),
  privateKey: ['-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIabc\n-----END ', 'RSA PRIVATE KEY-----'].join(''),
};

test('credential-shaped strings are detected and redacted', () => {
  for (const [name, value] of Object.entries(fake)) {
    const text = `prefix ${value} suffix`;
    assert.ok(detectSecrets(text).length > 0, name);
    const redacted = redactSecrets(text);
    assert.ok(!redacted.includes(value), name);
    assert.ok(redacted.includes('[redacted]'), name);
  }
  assert.deepEqual(detectSecrets('An ordinary description of a JavaScript framework.'), []);
});

test('text sanitization strips control and bidi characters and truncates', () => {
  assert.equal(sanitizeText('a‮b\u0000c​d   e'), 'abcd e');
  assert.equal(sanitizeText('x'.repeat(500), 20).length, 20);
  assert.equal(sanitizeText('   '), null);
});

test('URLs keep only http(s) origin and path', () => {
  assert.equal(sanitizeUrl('https://user:pass@example.com/docs?token=abc#x'), 'https://example.com/docs');
  assert.equal(sanitizeUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeUrl(`https://example.com/${fake.githubClassic}`), null);
});

test('repository records from untrusted nodes are sanitized and minimal', () => {
  const record = repositoryFromNode({
    __typename: 'Repository', id: 'R_1', nameWithOwner: 'owner/repo', stargazerCount: 5, forkCount: 1,
    description: `Deploy with ${fake.githubClassic}‮`, homepageUrl: 'https://x.test/?k=v', isFork: false, isPrivate: false,
    owner: { __typename: 'User', id: 'U_1', login: 'owner', location: 'Colombo', name: 'O' },
  }, { attribution: { accepted: true, countryCode: 'LK', confidence: 'medium', evidence: 'recognized-place' }, now: '2026-01-01T00:00:00Z' });
  assert.ok(!JSON.stringify(record).includes(fake.githubClassic));
  assert.equal(record.description, 'Deploy with [redacted]');
  assert.equal('homepageUrl' in record, false);
  assert.equal(repositoryFromNode({ __typename: 'Repository', id: 'R_2', nameWithOwner: 'a/b', isFork: true, owner: { id: 'U', login: 'a' } }), null);
  assert.equal(repositoryFromNode({ __typename: 'Repository', id: 'R_3', nameWithOwner: '../../etc', owner: { id: 'U', login: 'a' } }), null);
});

test('the persistence guard refuses to write credential-shaped content and withholds it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gitsphere-'));
  const file = path.join(directory, 'GH.json');
  await writeFile(file, '{}\n');
  await assert.rejects(writeJson(file, { description: fake.githubClassic }), (error) =>
    error.code === 'GITSPHERE_SECRET_GUARD' && !error.message.includes(fake.githubClassic) && error.message.includes('GH.json'));
  assert.equal(await readFile(file, 'utf8'), '{}\n', 'existing file untouched');
  assert.throws(() => assertNoSecrets(fake.aws, 'x'), /Value withheld/);
});
