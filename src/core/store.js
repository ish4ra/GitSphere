import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertNoSecrets } from './sanitize.js';

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) {
      const wrapped = new Error(`Corrupt JSON in ${filePath}: ${error.message}`);
      wrapped.code = 'GITSPHERE_CORRUPT_JSON';
      throw wrapped;
    }
    throw error;
  }
}

/**
 * Serializes JSON with top-level arrays written one element per line. This
 * keeps diffs small and readable for large record collections while staying
 * valid, standard JSON.
 */
export function stringifyRecords(value) {
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`;
  }
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  const lines = entries.map(([key, item]) => {
    const rendered = Array.isArray(item) && item.length && typeof item[0] === 'object'
      ? `[\n${item.map((element) => `  ${JSON.stringify(element)}`).join(',\n')}\n]`
      : JSON.stringify(item);
    return `${JSON.stringify(key)}: ${rendered}`;
  });
  return `{\n${lines.join(',\n')}\n}`;
}

/**
 * Writes atomically (temp file + rename) after the secret guard. Returns
 * false when the content is unchanged, so callers can avoid needless churn.
 */
export async function writeJson(filePath, value, { compact = true } = {}) {
  const content = `${compact ? stringifyRecords(value) : JSON.stringify(value, null, 2)}\n`;
  return writeText(filePath, content);
}

export async function writeText(filePath, content) {
  assertNoSecrets(content, path.basename(filePath));
  let previous = null;
  try {
    previous = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (previous === content) return false;
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, filePath);
  return true;
}

export async function listCodes(directory) {
  try {
    return (await readdir(directory))
      .map((name) => name.match(/^([A-Z]{2})\.json$/)?.[1])
      .filter(Boolean)
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** Per-country JSON documents with lazy loading and dirty tracking. */
export class CountryDocuments {
  constructor(directory, create) {
    this.directory = directory;
    this.create = create;
    this.cache = new Map();
    this.dirty = new Set();
  }

  async load(code) {
    if (this.cache.has(code)) return this.cache.get(code);
    const existing = await readJson(path.join(this.directory, `${code}.json`), null);
    const value = this.create(code, existing);
    this.cache.set(code, value);
    return value;
  }

  async loadAll(codes) {
    for (const code of codes) await this.load(code);
    return this.cache;
  }

  markDirty(code) {
    this.dirty.add(code);
  }

  async flush(serialize = (value) => value) {
    const written = [];
    for (const code of [...this.dirty].sort()) {
      const changed = await writeJson(path.join(this.directory, `${code}.json`), serialize(this.cache.get(code)));
      if (changed) written.push(code);
    }
    this.dirty.clear();
    return written;
  }
}
