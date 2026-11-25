import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');

test('only the pipeline and geography sync write data, under one shared lock', () => {
  const writers = readdirSync(new URL('../.github/workflows/', import.meta.url)).filter((name) => /contents:\s*write/.test(read(name)));
  assert.deepEqual(writers.sort(), ['pipeline.yml', 'sync-geography.yml']);
  for (const name of writers) {
    const text = read(name);
    assert.match(text, /group: gitsphere-data-\$\{\{ github\.ref \}\}/, name);
    assert.match(text, /cancel-in-progress: false/, name);
    assert.doesNotMatch(text, /^\s*push:/m, `${name} must not run on push (no trigger loops)`);
    assert.doesNotMatch(text, /--force|push -f/, `${name} must never force-push`);
  }
});

test('the pipeline commits checkpoints before failing on a stall, and scans for secrets', () => {
  const text = read('pipeline.yml');
  const commit = text.indexOf('Commit progress');
  assert.ok(text.indexOf('Secret guard') < commit);
  assert.ok(commit < text.indexOf('assert-progress.js'));
  assert.match(text, /git rebase --abort/);
});

test('CI is read-only', () => {
  assert.match(read('ci.yml'), /contents: read/);
  assert.doesNotMatch(read('ci.yml'), /contents: write/);
});

test('only the new workflows exist and only they run on a schedule', () => {
  const names = readdirSync(new URL('../.github/workflows/', import.meta.url)).sort();
  assert.deepEqual(names, ['ci.yml', 'pipeline.yml', 'sync-geography.yml'], 'obsolete crawler workflows are removed');
  const scheduled = names.filter((name) => /^\s*schedule:/m.test(read(name)));
  assert.deepEqual(scheduled, ['pipeline.yml', 'sync-geography.yml']);
});

test('the pipeline needs only the built-in GITHUB_TOKEN', () => {
  for (const name of ['pipeline.yml', 'ci.yml', 'sync-geography.yml']) {
    const secrets = [...read(name).matchAll(/\$\{\{\s*secrets\.(\w+)/g)].map((match) => match[1]);
    assert.ok(secrets.every((secret) => secret === 'GITHUB_TOKEN'), `${name} uses ${secrets.join(', ')}`);
  }
  assert.doesNotMatch(read('pipeline.yml'), /npm (ci|install)/, 'no third-party dependencies are installed');
});

test('checkpoints are committed even when the pipeline step fails, but never past the secret guard', () => {
  const text = read('pipeline.yml');
  assert.match(text, /id: pipeline\n\s+# [^\n]*\n\s+timeout-minutes: 47/);
  assert.match(text, /if: always\(\) && steps\.secrets\.outcome == 'success'/);
});

test('the launch recovery runs once, before the pipeline, inside the single writer', () => {
  const text = read('pipeline.yml');
  const recovery = text.indexOf('One-time recovery');
  assert.ok(recovery > 0 && recovery < text.indexOf('Discover, refresh and publish'));
  assert.match(text, /typenameRecovery \? 0 : 1/);
  assert.match(text, /restore-legacy-repositories\.js d9f6afa23badc7796d86cab9dbd781a8f93f2d30/);
});
