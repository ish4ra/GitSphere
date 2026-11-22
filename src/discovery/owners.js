// Owners (found by location discovery) with more than one public repository
// whose top repository could reach their country's ranking. Their other
// repositories are fetched so a country's second-best repository from the
// same owner is not missed.

import path from 'node:path';
import { readJson, writeJson } from '../core/store.js';

const PER_COUNTRY_LIMIT = 150;

export class OwnerCandidates {
  constructor(stateDir) {
    this.file = path.join(stateDir, 'repositories', 'owners.json');
    this.byCountry = new Map();
    this.expanded = new Map();
  }

  async load() {
    const doc = await readJson(this.file, null);
    for (const { code, ...owner } of doc?.owners || []) {
      if (!this.byCountry.has(code)) this.byCountry.set(code, new Map());
      this.byCountry.get(code).set(owner.id, owner);
    }
    return this;
  }

  add(code, owner) {
    let owners = this.byCountry.get(code);
    if (!owners) this.byCountry.set(code, (owners = new Map()));
    const previous = owners.get(owner.id);
    owners.set(owner.id, { ...previous, ...owner, expandedAt: previous?.expandedAt || null });
    if (owners.size > PER_COUNTRY_LIMIT) {
      const sorted = [...owners.values()].sort((a, b) => b.topStars - a.topStars || a.id.localeCompare(b.id));
      this.byCountry.set(code, new Map(sorted.slice(0, PER_COUNTRY_LIMIT).map((item) => [item.id, item])));
    }
  }

  /** Owners not expanded within `days` whose top repository meets the cutoff. */
  due(now, days, cutoffFor) {
    const staleBefore = Date.parse(now) - days * 86_400_000;
    const due = [];
    for (const [code, owners] of this.byCountry) {
      const cutoff = cutoffFor(code);
      for (const owner of owners.values()) {
        if (owner.topStars < cutoff) continue;
        if (owner.expandedAt && Date.parse(owner.expandedAt) > staleBefore) continue;
        due.push({ ...owner, code });
      }
    }
    return due.sort((a, b) => b.topStars - a.topStars || a.id.localeCompare(b.id));
  }

  markExpanded(id, now) {
    for (const owners of this.byCountry.values()) {
      const owner = owners.get(id);
      if (owner) owner.expandedAt = now;
    }
  }

  pending(code) {
    return [...(this.byCountry.get(code)?.values() || [])].filter((owner) => !owner.expandedAt).length;
  }

  async save() {
    const owners = [];
    for (const code of [...this.byCountry.keys()].sort()) {
      const sorted = [...this.byCountry.get(code).values()].sort((a, b) => b.topStars - a.topStars || a.id.localeCompare(b.id));
      for (const owner of sorted) owners.push({ code, ...owner });
    }
    await writeJson(this.file, { schemaVersion: 3, count: owners.length, owners });
  }
}
