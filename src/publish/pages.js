// Country ranking pages and per-mode country directories.

import { COUNTRIES } from '../countries.js';
import { REPOSITORY_URL } from '../core/identity.js';
import { STATUSES } from '../rankings/build.js';
import {
  avatarUrl,
  compactNumber,
  escapeHtml,
  formatDate,
  formatNumber,
  MODE_META,
  profileUrl,
  relative,
  repositoryUrl,
  STATUS_LABELS,
  statusText,
  truncate,
} from './format.js';

const MODES = ['repositories', 'developers', 'contributors'];

function header(file, mode, country) {
  const meta = MODE_META[mode];
  const nav = MODES.map((item) => {
    const label = MODE_META[item].title;
    if (item === mode) return `<b>${label}</b>`;
    return `<a href="${relative(file, MODE_META[item].page(country.slug))}">${label}</a>`;
  }).join(' &nbsp;·&nbsp; ');
  return [
    '<div align="center">',
    '',
    `<a href="${relative(file, 'README.md')}"><img src="${relative(file, 'assets/brand/gitsphere-mark.svg')}" width="44" height="44" alt="GitSphere"></a>`,
    '',
    `# ${country.flag} ${escapeHtml(country.name)}`,
    '',
    `<b>${meta.title}</b> — ${escapeHtml(meta.tagline.replace(' by country', ''))}`,
    '',
    `<sub>${nav}</sub>`,
    '',
    '</div>',
    '',
  ];
}

function footer(file, mode) {
  return [
    '',
    '---',
    '',
    `<p align="center"><sub><a href="${relative(file, MODE_META[mode].directory)}">← All countries</a> &nbsp;·&nbsp; <a href="${relative(file, 'README.md')}">GitSphere home</a> &nbsp;·&nbsp; <a href="${relative(file, 'docs/METHODOLOGY.md')}">Methodology</a> &nbsp;·&nbsp; <a href="${REPOSITORY_URL}">Source</a></sub></p>`,
    '',
  ];
}

function summaryLine(ranking, published) {
  const meta = MODE_META[ranking.mode];
  return [
    '<div align="center">',
    '',
    `| Status | ${meta.noun[0].toUpperCase()}${meta.noun.slice(1)} | Oldest verification | Data |`,
    '| :---: | :---: | :---: | :---: |',
    `| ${statusText(ranking.status)} | **${formatNumber(ranking.entries.length)}** | ${published.verifiedOn ? formatDate(published.verifiedOn) : '—'} | <a href="${published.dataLink}">JSON</a> |`,
    '',
    ...(ranking.coverage.legacyEntriesPendingRevalidation
      ? [`> **Not yet re-verified.** ${formatNumber(ranking.coverage.legacyEntriesPendingRevalidation)} of these entries were carried over from the previous dataset and are pending revalidation against the GitHub API. Dates show when each entry was last observed.`, '']
      : []),
    '</div>',
    '',
  ];
}

export function renderCountryPage(ranking, published) {
  const mode = ranking.mode;
  const file = MODE_META[mode].page(ranking.country.slug);
  const lines = [...header(file, mode, ranking.country), ...summaryLine(ranking, { ...published, dataLink: relative(file, MODE_META[mode].data(ranking.country.code)) })];

  if (!ranking.entries.length) {
    lines.push(...emptyState(ranking));
  } else if (mode === 'repositories') {
    lines.push(...repositoryTable(ranking));
  } else if (mode === 'developers') {
    lines.push(...developerTable(ranking));
  } else {
    lines.push(...contributorTable(ranking));
  }
  lines.push(...coverageSection(ranking), ...footer(file, mode));
  return lines.join('\n');
}

function emptyState(ranking) {
  const text = {
    building: 'Discovery for this country is still running. Results appear here automatically as soon as attributable entries are found and verified.',
    empty: 'Discovery finished without finding any public GitHub profile whose location attributes unambiguously to this country. GitSphere does not fabricate or guess results.',
    blocked: 'Discovery for this country is failing repeatedly and is being investigated. Existing checkpoints are preserved.',
  }[ranking.status] || 'No entries yet.';
  return ['> ' + text, ''];
}

function repositoryTable(ranking) {
  const lines = [
    '<table>',
    '<thead><tr><th align="right">#</th><th align="left">Repository</th><th align="right">Stars</th><th align="right">Forks</th><th align="left">Language</th></tr></thead>',
    '<tbody>',
  ];
  for (const [index, repo] of ranking.entries.entries()) {
    const owner = repo.owner || {};
    const description = truncate(repo.description, 120);
    lines.push(
      '<tr>',
      `<td align="right">${index + 1}</td>`,
      `<td><img src="${avatarUrl({ login: owner.login }, 20)}" width="20" height="20" alt=""> <a href="${repositoryUrl(repo.name)}"><b>${escapeHtml(repo.name)}</b></a>${repo.archived ? ' <sub>archived</sub>' : ''}${description ? `<br><sub>${escapeHtml(description)}</sub>` : ''}</td>`,
      `<td align="right"><b>${formatNumber(repo.stars)}</b></td>`,
      `<td align="right">${formatNumber(repo.forks)}</td>`,
      `<td>${escapeHtml(repo.language || '—')}</td>`,
      '</tr>',
    );
  }
  lines.push('</tbody>', '</table>', '');
  return lines;
}

function developerTable(ranking) {
  const lines = [
    '<table>',
    '<thead><tr><th align="right">#</th><th align="left">Developer</th><th align="right">Followers</th><th align="right">Public repos</th><th align="left">Location</th></tr></thead>',
    '<tbody>',
  ];
  for (const [index, user] of ranking.entries.entries()) {
    lines.push(
      '<tr>',
      `<td align="right">${index + 1}</td>`,
      `<td><a href="${profileUrl(user.login)}"><img src="${avatarUrl(user, 32)}" width="32" height="32" alt="" align="left"></a><a href="${profileUrl(user.login)}"><b>${escapeHtml(user.name || user.login)}</b></a><br><sub>&#64;${escapeHtml(user.login)}</sub></td>`,
      `<td align="right"><b>${formatNumber(user.followers)}</b></td>`,
      `<td align="right">${formatNumber(user.publicRepos)}</td>`,
      `<td><sub>${escapeHtml(truncate(user.location, 48))}</sub></td>`,
      '</tr>',
    );
  }
  lines.push('</tbody>', '</table>', '');
  return lines;
}

function contributorTable(ranking) {
  const window = ranking.coverage.window;
  const lines = [
    window ? `<p align="center"><sub>Public contributions from <b>${formatDate(window.from)}</b> to <b>${formatDate(window.to)}</b> (rolling 12 months, per account measurement time)</sub></p>` : '',
    '',
    '<table>',
    '<thead><tr><th align="right">#</th><th align="left">Developer</th><th align="right">Public contributions</th><th align="right">Commits</th><th align="right">PRs</th><th align="right">Reviews</th><th align="right">Issues</th></tr></thead>',
    '<tbody>',
  ];
  for (const [index, user] of ranking.entries.entries()) {
    const c = user.contributions;
    lines.push(
      '<tr>',
      `<td align="right">${index + 1}</td>`,
      `<td><a href="${profileUrl(user.login)}"><img src="${avatarUrl(user, 32)}" width="32" height="32" alt="" align="left"></a><a href="${profileUrl(user.login)}"><b>${escapeHtml(user.name || user.login)}</b></a><br><sub>&#64;${escapeHtml(user.login)} · ${formatNumber(user.followers)} followers</sub></td>`,
      `<td align="right"><b>${formatNumber(c.public)}</b></td>`,
      `<td align="right">${formatNumber(c.commits)}</td>`,
      `<td align="right">${formatNumber(c.pullRequests)}</td>`,
      `<td align="right">${formatNumber(c.reviews)}</td>`,
      `<td align="right">${formatNumber(c.issues)}</td>`,
      '</tr>',
    );
  }
  lines.push('</tbody>', '</table>', '');
  return lines;
}

function coverageSection(ranking) {
  const c = ranking.coverage;
  const loc = c.location || {};
  const lines = ['<details>', '<summary><b>Coverage and methodology</b></summary>', ''];
  lines.push(`- **Status:** ${STATUS_LABELS[ranking.status].label}. ${statusExplanation(ranking)}`);
  if (ranking.mode === 'repositories') {
    lines.push(
      `- **Basis:** ${basisText(c.basis)} The current global star-scan level is reported in [\`data/summary.json\`](${relative(MODE_META.repositories.page(ranking.country.slug), 'data/summary.json')}).`,
      `- **Cutoff:** the last listed repository has ${c.cutoffStars != null ? formatNumber(c.cutoffStars) : '—'} stars; ${formatNumber(c.candidates)} attributed candidates are tracked.`,
    );
    if (c.legacyEntriesPendingRevalidation) lines.push(`- ${formatNumber(c.legacyEntriesPendingRevalidation)} entries were carried over from the previous dataset and are pending revalidation.`);
    if (c.ownerExpansionBacklog) lines.push(`- ${formatNumber(c.ownerExpansionBacklog)} multi-repository owners are queued for expansion.`);
  } else if (ranking.mode === 'developers') {
    lines.push(
      `- **Basis:** ${basisText(c.basis)}`,
      `- Organizations are excluded. ${formatNumber(c.candidates)} attributed developers are tracked; the cutoff is ${c.cutoffFollowers != null ? formatNumber(c.cutoffFollowers) : '—'} followers.`,
    );
  } else {
    lines.push(
      `- **Measured:** ${formatNumber(c.measuredAccounts)} of ${formatNumber(c.discoveredAccounts)} discovered developers (${formatNumber(c.measurementBacklog)} awaiting measurement).`,
      '- **Public contributions** = contribution-calendar total minus restricted (private) contributions, over a rolling 12-month window. This is not a lifetime count and not commits alone.',
      '- Candidates are discovered independently of follower counts, but GitSphere cannot enumerate every GitHub account, so this ranking is not exhaustive.',
    );
  }
  lines.push(
    `- **Location discovery:** ${loc.complete ? `round completed ${formatDate(loc.lastCompletedAt)}` : `term ${formatNumber(loc.termIndex)} of ${formatNumber(loc.terms)} in round ${formatNumber(loc.round || 1)}`}${loc.unresolved ? `, ${formatNumber(loc.unresolved)} unresolved search partitions recorded` : ''}.`,
    '- Country attribution uses the public GitHub profile location only — not citizenship, nationality, IP address or legal incorporation. Ambiguous and unrecognized locations are excluded, never guessed.',
    '',
    '</details>',
  );
  return lines;
}

function basisText(basis) {
  return {
    'global-star-scan': 'certified by the global star scan — every repository above this cutoff has been enumerated.',
    'global-follower-scan': 'certified by the global follower scan — every developer above this cutoff has been enumerated.',
    'location-discovery': 'certified by complete location discovery for this country.',
    'measured-discovered-accounts': 'every discovered developer has been measured.',
    partial: 'partial — discovery is still running.',
  }[basis] || 'partial — discovery is still running.';
}

function statusExplanation(ranking) {
  switch (ranking.status) {
    case 'published':
      return ranking.coverage.basis === 'location-discovery'
        ? 'Every discovery term for this country was searched without unresolved partitions and the global scan has passed this ranking’s cutoff where applicable.'
        : 'The global scan has verified every entry above this ranking’s cutoff.';
    case 'provisional':
      return 'These are verified results found so far; deeper discovery is still running and the list may change.';
    case 'stale':
      return 'Some entries have not been re-verified in the last 14 days.';
    default:
      return '';
  }
}

export function renderDirectory(mode, rankings, { summary }) {
  const meta = MODE_META[mode];
  const file = meta.directory;
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const ranking of rankings.values()) counts[ranking.status] += 1;

  const groups = new Map();
  for (const country of COUNTRIES) {
    const letter = country.name.normalize('NFKD').replace(/[^A-Za-z]/g, '').charAt(0).toUpperCase() || '#';
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(country);
  }
  const letters = [...groups.keys()].sort();

  const lines = [
    '<div align="center">',
    '',
    `<a href="${relative(file, 'README.md')}"><img src="${relative(file, 'assets/brand/gitsphere-mark.svg')}" width="44" height="44" alt="GitSphere"></a>`,
    '',
    `# ${meta.title}`,
    '',
    escapeHtml(meta.tagline),
    '',
    `<sub>${MODES.map((item) => (item === mode ? `<b>${MODE_META[item].title}</b>` : `<a href="${relative(file, MODE_META[item].directory)}">${MODE_META[item].title}</a>`)).join(' &nbsp;·&nbsp; ')}</sub>`,
    '',
    `**${COUNTRIES.length}** countries and territories · ${STATUSES.filter((status) => counts[status]).map((status) => `${STATUS_LABELS[status].dot} ${formatNumber(counts[status])} ${STATUS_LABELS[status].label.toLowerCase()}`).join(' · ')}`,
    '',
    `<sub>${letters.map((letter) => `<a href="#${letter.toLowerCase()}">${letter}</a>`).join(' ')}</sub>`,
    '',
    '</div>',
    '',
  ];

  for (const letter of letters) {
    lines.push(`### ${letter}`, '', `| Country | Status | ${meta.noun[0].toUpperCase()}${meta.noun.slice(1)} | Leader | Verified |`, '| :-- | :-- | --: | :-- | :-- |');
    for (const country of groups.get(letter)) {
      const ranking = rankings.get(country.code);
      const published = summary.get(country.code) || {};
      lines.push(
        `| ${country.flag} [${escapeHtml(country.name)}](${relative(file, meta.page(country.slug))}) | ${statusText(ranking.status)} | ${ranking.entries.length ? formatNumber(ranking.entries.length) : '—'} | ${leaderCell(mode, ranking)} | ${published.verifiedOn ? formatDate(published.verifiedOn) : '—'} |`,
      );
    }
    lines.push('');
  }
  lines.push(
    '<details>',
    '<summary><b>Status definitions</b></summary>',
    '',
    `- ${statusText('published')} — coverage established by the global scan cutoff or by complete location discovery.`,
    `- ${statusText('provisional')} — useful verified results; discovery is still running.`,
    `- ${statusText('building')} — no results yet; discovery in progress.`,
    `- ${statusText('stale')} — results not re-verified within 14 days.`,
    `- ${statusText('empty')} — discovery finished without attributable results.`,
    `- ${statusText('blocked')} — discovery failing repeatedly.`,
    '',
    '</details>',
    ...footer(file, mode).slice(1),
  );
  return lines.join('\n');
}

function leaderCell(mode, ranking) {
  const top = ranking.entries[0];
  if (!top) return '—';
  if (mode === 'repositories') return `<sub>${escapeHtml(truncate(top.name, 36))} · ★ ${compactNumber(top.stars)}</sub>`;
  if (mode === 'developers') return `<sub>&#64;${escapeHtml(top.login)} · ${compactNumber(top.followers)}</sub>`;
  return `<sub>&#64;${escapeHtml(top.login)} · ${compactNumber(top.contributions.public)}</sub>`;
}
