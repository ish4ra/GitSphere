// Root README: the GitSphere landing page. Generated on every pipeline run;
// edit this template rather than README.md.

import { PROJECT_DESCRIPTION, PROJECT_TAGLINE, REPOSITORY_URL } from '../core/identity.js';
import { COUNTRIES } from '../countries.js';
import { formatDate, formatNumber, MODE_META, STATUS_LABELS } from './format.js';

const CARDS = ['repositories', 'developers', 'contributors'];

export function renderRootReadme(summary) {
  const modes = summary?.modes || {};
  const scans = summary?.scans || {};
  const lastRun = summary?.lastRun || null;

  const card = (mode) => {
    const meta = MODE_META[mode];
    const stats = modes[mode] || { countriesWithResults: 0, entries: 0, counts: {} };
    return [
      '<td width="33%" align="center" valign="top">',
      `<a href="./${meta.directory}">`,
      '<picture>',
      `<source media="(prefers-color-scheme: dark)" srcset="./assets/brand/card-${mode}-dark.svg">`,
      `<img src="./assets/brand/card-${mode}-light.svg" width="100%" alt="${meta.title}: ${meta.tagline}">`,
      '</picture>',
      '</a>',
      '<br>',
      `<a href="./${meta.directory}"><b>Browse ${COUNTRIES.length} countries →</b></a>`,
      '<br>',
      `<sub>${formatNumber(stats.entries)} ${meta.noun} ranked · ${formatNumber(stats.countriesWithResults)} countries with results</sub>`,
      '</td>',
    ].join('\n');
  };

  const statusRow = (mode) => {
    const counts = modes[mode]?.counts || {};
    const cells = ['published', 'provisional', 'building', 'stale', 'empty', 'blocked'].map((status) => formatNumber(counts[status] || 0));
    return `| ${MODE_META[mode].title} | ${cells.join(' | ')} | ${formatNumber(counts.total || COUNTRIES.length)} |`;
  };

  const lines = [
    '<div align="center">',
    '',
    '<picture>',
    '<source media="(prefers-color-scheme: dark)" srcset="./assets/brand/banner-dark.svg">',
    `<img src="./assets/brand/banner-light.svg" width="100%" alt="GitSphere — ${PROJECT_TAGLINE}">`,
    '</picture>',
    '',
    `### ${PROJECT_TAGLINE}`,
    '',
    PROJECT_DESCRIPTION,
    '',
    `<a href="${REPOSITORY_URL}/actions/workflows/pipeline.yml"><img src="${REPOSITORY_URL}/actions/workflows/pipeline.yml/badge.svg" alt="Pipeline status"></a>`,
    '',
    '</div>',
    '',
    '<br>',
    '',
    '<table>',
    '<tr>',
    ...CARDS.map(card),
    '</tr>',
    '</table>',
    '',
    '<div align="center">',
    '',
    `<sub>Data refreshed ${lastRun?.startedAt ? `<b>${formatDate(lastRun.startedAt)}</b>` : '—'} · ${formatNumber(COUNTRIES.length)} countries and territories · Star scan verified to <b>${scans.repositories?.verifiedFloor != null ? `${formatNumber(scans.repositories.verifiedFloor)}★` : '—'}</b> · Follower scan verified to <b>${scans.followers?.verifiedFloor != null ? formatNumber(scans.followers.verifiedFloor) : '—'}</b></sub>`,
    '',
    '</div>',
    '',
    '## Coverage',
    '',
    `| Ranking | ${['published', 'provisional', 'building', 'stale', 'empty', 'blocked'].map((status) => `${STATUS_LABELS[status].dot} ${STATUS_LABELS[status].label}`).join(' | ')} | Total |`,
    '| :-- | --: | --: | --: | --: | --: | --: | --: |',
    ...CARDS.map(statusRow),
    '',
    'Every country has exactly one status per ranking. **Published** means coverage was established by the scans; **Provisional** rankings are verified results while deeper discovery continues. Nothing is presented as complete unless the scan establishes it.',
    '',
    '## How it works',
    '',
    '- **Country attribution** comes from the public GitHub profile location — of the repository owner or of the developer — resolved by one shared, population-aware gazetteer of 250 countries and territories, 5,800+ subdivisions and 700,000+ places with native and alternate names. Ambiguous locations such as `Portland` or `Georgia` are never forced into a country.',
    '- **Repositories** are discovered by a continuous global scan of public non-fork repositories in descending star order, recursively partitioned by stars and creation time to work within GitHub’s 1,000-result search window, plus per-country location discovery for smaller ecosystems.',
    '- **Developers** are ranked by public follower count. Organizations are excluded.',
    '- **Contributors** are ranked by public contributions over a rolling 12-month window (contribution-calendar total minus restricted private contributions), measured independently of follower rankings.',
    '- Every candidate is re-verified by stable GitHub node ID before publication, so renamed, transferred, deleted and relocated repositories and accounts are handled.',
    '',
    '## Data',
    '',
    '| Resource | Description |',
    '| :-- | :-- |',
    '| [`docs/METHODOLOGY.md`](./docs/METHODOLOGY.md) | Attribution, discovery, certification and status rules |',
    '| [`data/summary.json`](./data/summary.json) | Global coverage and status summary |',
    '| [`data/`](./data/) | Repository rankings (`data/<CC>.json`), `data/developers/`, `data/contributors/` |',
    '| [`geography/`](./geography/) | Generated gazetteer (Countries States Cities Database, GeoNames) |',
    '| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | What comes next |',
    '',
    '<details>',
    '<summary><b>Run locally</b></summary>',
    '',
    '```bash',
    'npm run check                 # syntax check + tests',
    'GITHUB_TOKEN=… npm run pipeline   # one bounded pipeline run',
    'npm run publish               # regenerate pages from saved state',
    '```',
    '',
    'Requires Node.js 22+. No dependencies, databases or paid services.',
    '',
    '</details>',
    '',
    '## License',
    '',
    'GitSphere code is released under the [MIT License](./LICENSE). Geography data: Countries States Cities Database (ODbL-1.0) and GeoNames (CC BY 4.0). Ranking data is derived from public GitHub profiles and repositories. GitSphere is an independent open-source project and is not affiliated with or endorsed by GitHub.',
  ];
  return lines.join('\n');
}
