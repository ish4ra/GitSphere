// Formatting helpers for GitHub-flavored Markdown/HTML output. Every value
// that originates from GitHub metadata is escaped here before rendering.

export const STATUS_LABELS = Object.freeze({
  published: { label: 'Published', dot: '🟢' },
  provisional: { label: 'Provisional', dot: '🟡' },
  building: { label: 'Building', dot: '🔵' },
  stale: { label: 'Stale', dot: '🟠' },
  empty: { label: 'No attributable results', dot: '⚪' },
  blocked: { label: 'Blocked', dot: '🔴' },
});

export const MODE_META = Object.freeze({
  repositories: {
    title: 'Top Repositories',
    noun: 'repositories',
    tagline: 'Discover the most-starred GitHub repositories by country.',
    directory: 'rankings/README.md',
    page: (slug) => `rankings/${slug}.md`,
    data: (code) => `data/${code}.json`,
    icon: 'assets/brand/icon-repositories.svg',
  },
  developers: {
    title: 'Top Developers',
    noun: 'developers',
    tagline: 'Discover GitHub users ranked by followers.',
    directory: 'rankings/developers/README.md',
    page: (slug) => `rankings/developers/${slug}.md`,
    data: (code) => `data/developers/${code}.json`,
    icon: 'assets/brand/icon-developers.svg',
  },
  contributors: {
    title: 'Top Contributors',
    noun: 'contributors',
    tagline: 'Discover GitHub users ranked by public contribution activity.',
    directory: 'rankings/contributors/README.md',
    page: (slug) => `rankings/contributors/${slug}.md`,
    data: (code) => `data/contributors/${code}.json`,
    icon: 'assets/brand/icon-contributors.svg',
  },
});

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\|/g, '&#124;')
    .replace(/`/g, '&#96;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/\*/g, '&#42;')
    .replace(/_/g, '&#95;')
    .replace(/@/g, '&#64;');
}

export function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

export function compactNumber(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}M`;
  if (number >= 10_000) return `${Math.round(number / 1000)}k`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}k`;
  return String(number);
}

export function formatDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' }).format(date);
}

export function isoDate(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

export function statusText(status) {
  const meta = STATUS_LABELS[status] || STATUS_LABELS.building;
  return `${meta.dot} ${meta.label}`;
}

/** Relative link from one repository path to another. */
export function relative(fromFile, toFile) {
  const from = fromFile.split('/').slice(0, -1);
  const to = toFile.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common += 1;
  const up = from.length - common;
  return `${up ? '../'.repeat(up) : './'}${to.slice(common).join('/')}`;
}

export function truncate(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function avatarUrl(account, size = 40) {
  if (Number.isInteger(account?.databaseId)) {
    return `https://avatars.githubusercontent.com/u/${account.databaseId}?s=${size * 2}&v=4`;
  }
  return `https://github.com/${encodeURIComponent(account?.login || 'ghost')}.png?size=${size * 2}`;
}

export function profileUrl(login) {
  return `https://github.com/${encodeURIComponent(login)}`;
}

export function repositoryUrl(nameWithOwner) {
  return `https://github.com/${String(nameWithOwner).split('/').map(encodeURIComponent).join('/')}`;
}
