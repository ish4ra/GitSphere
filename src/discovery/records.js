// Converts untrusted GitHub GraphQL nodes into minimal, sanitized records.
// Only fields needed for ranking, attribution and display are retained.

import {
  sanitizeCount,
  sanitizeLogin,
  sanitizeNameWithOwner,
  sanitizeText,
} from '../core/sanitize.js';

export const RECORD_SCHEMA_VERSION = 3;

export function attributionSummary(attribution) {
  if (!attribution) return null;
  return {
    code: attribution.accepted ? attribution.countryCode : null,
    confidence: attribution.confidence,
    evidence: attribution.evidence,
  };
}

export function ownerFromNode(owner) {
  if (!owner?.id) return null;
  const login = sanitizeLogin(owner.login);
  if (!login) return null;
  return {
    id: String(owner.id),
    login,
    type: owner.__typename === 'Organization' ? 'Organization' : 'User',
    name: sanitizeText(owner.name, 80),
    location: sanitizeText(owner.location, 120),
  };
}

export function repositoryFromNode(node, { attribution, now, cycle = null } = {}) {
  if (!node || node.__typename !== 'Repository' || !node.id) return null;
  if (node.isFork || node.isPrivate) return null;
  const name = sanitizeNameWithOwner(node.nameWithOwner);
  const owner = ownerFromNode(node.owner);
  if (!name || !owner) return null;
  return {
    id: String(node.id),
    name,
    stars: sanitizeCount(node.stargazerCount),
    forks: sanitizeCount(node.forkCount),
    language: sanitizeText(node.primaryLanguage?.name, 40),
    license: sanitizeText(node.licenseInfo?.spdxId, 40),
    description: sanitizeText(node.description, 160),
    archived: Boolean(node.isArchived),
    createdAt: node.createdAt || null,
    pushedAt: node.pushedAt || null,
    owner,
    attribution: attributionSummary(attribution),
    seenAt: now,
    verifiedAt: now,
    ...(cycle != null ? { cycle } : {}),
  };
}

export function accountFromNode(node, { attribution, now, source } = {}) {
  if (!node?.id || !['User', 'Organization'].includes(node.__typename)) return null;
  const login = sanitizeLogin(node.login);
  if (!login) return null;
  return {
    id: String(node.id),
    databaseId: Number.isInteger(node.databaseId) ? node.databaseId : null,
    login,
    type: node.__typename,
    name: sanitizeText(node.name, 80),
    location: sanitizeText(node.location, 120),
    followers: node.followers ? sanitizeCount(node.followers.totalCount) : null,
    publicRepos: node.repositories ? sanitizeCount(node.repositories.totalCount) : null,
    createdAt: node.createdAt || null,
    attribution: attributionSummary(attribution),
    seenAt: now,
    sources: source ? [source] : [],
  };
}

/** Repository owner (from a repository search node) as an account record. */
export function accountFromRepositoryOwner(owner, { attribution, now }) {
  if (!owner || owner.__typename !== 'User') return null;
  return accountFromNode(
    { ...owner, repositories: null },
    { attribution, now, source: 'repository-owner' },
  );
}

export function compareRepositories(a, b) {
  return (
    (b.stars || 0) - (a.stars || 0) ||
    (b.forks || 0) - (a.forks || 0) ||
    String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase()) ||
    String(a.id).localeCompare(String(b.id))
  );
}

export function compareByFollowers(a, b) {
  return (
    (b.followers || 0) - (a.followers || 0) ||
    (b.publicRepos || 0) - (a.publicRepos || 0) ||
    String(a.login).toLowerCase().localeCompare(String(b.login).toLowerCase()) ||
    String(a.id).localeCompare(String(b.id))
  );
}

export function compareByContributions(a, b) {
  return (
    (b.contributions?.public || 0) - (a.contributions?.public || 0) ||
    (b.contributions?.commits || 0) - (a.contributions?.commits || 0) ||
    (b.followers || 0) - (a.followers || 0) ||
    String(a.login).toLowerCase().localeCompare(String(b.login).toLowerCase()) ||
    String(a.id).localeCompare(String(b.id))
  );
}
