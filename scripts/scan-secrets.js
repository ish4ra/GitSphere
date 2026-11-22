#!/usr/bin/env node
// Scans generated files for credential-shaped strings. Prints file and
// pattern names only — never the matched value.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { detectSecrets } from '../src/core/sanitize.js';

const targets = process.argv.slice(2);
let findings = 0;
let files = 0;

async function visit(target) {
  let info;
  try {
    info = await stat(target);
  } catch {
    return;
  }
  if (info.isDirectory()) {
    for (const entry of await readdir(target)) await visit(path.join(target, entry));
    return;
  }
  if (!/\.(json|md)$/.test(target)) return;
  files += 1;
  const found = detectSecrets(await readFile(target, 'utf8'));
  if (found.length) {
    findings += 1;
    console.error(`::error file=${target}::credential-shaped content (${found.join(', ')})`);
  }
}

for (const target of targets) await visit(target);
console.log(`Secret scan: ${files} files, ${findings} with findings.`);
if (findings) process.exit(1);
