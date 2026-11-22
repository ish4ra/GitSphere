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
