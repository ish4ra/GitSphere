import test from 'node:test';
import assert from 'node:assert/strict';
import * as queries from '../src/github/queries.js';

// GraphQL rejects documents with undefined or unused fragments. This checks
// every query document GitSphere sends.
const documents = {
  ...Object.fromEntries(Object.entries(queries).filter(([, value]) => typeof value === 'string')),
  repositoriesByName: queries.repositoriesByName(['torvalds/linux', 'microsoft/vscode']),
};

test('every fragment is defined exactly once and used', () => {
  for (const [name, document] of Object.entries(documents)) {
    const defined = [...document.matchAll(/fragment (\w+) on/g)].map((match) => match[1]);
    const used = new Set([...document.matchAll(/\.\.\.(\w+)/g)].map((match) => match[1]).filter((item) => item !== 'on'));
    assert.equal(new Set(defined).size, defined.length, `${name}: duplicate fragment`);
    for (const fragment of defined) assert.ok(used.has(fragment), `${name}: unused fragment ${fragment}`);
    for (const fragment of used) assert.ok(defined.includes(fragment), `${name}: undefined fragment ${fragment}`);
    assert.equal((document.match(/\{/g) || []).length, (document.match(/\}/g) || []).length, `${name}: balanced braces`);
  }
});

test('legacy name lookups are safely quoted', () => {
  const document = queries.repositoriesByName(['a/b"c']);
  assert.ok(document.includes('name: "b\\"c"'));
});

test('repository nodes always carry __typename, wherever the fragment is used', () => {
  // Ingestion accepts only nodes whose __typename is "Repository". The
  // fragment itself must request it: aliased lookups, owner repositories
  // and top repositories rely on the fragment alone.
  for (const [name, document] of Object.entries(documents)) {
    const fragment = document.match(/fragment GitSphereRepository on Repository \{\s*([\s\S]*?)\n\s*\}\s*$/m);
    if (!document.includes('fragment GitSphereRepository')) continue;
    assert.match(document, /fragment GitSphereRepository on Repository \{\s*__typename/, `${name}: fragment must request __typename`);
    void fragment;
  }
});
