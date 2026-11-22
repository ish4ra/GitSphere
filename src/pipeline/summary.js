// Markdown run report for GitHub Actions job summaries and logs.
export function renderJobSummary(report) {
  const lines = [
    '## GitSphere pipeline run',
    '',
    `- Progress: **${report.progress?.ok ? 'yes' : 'NO'}** (${report.progress?.reason})`,
    `- API requests: **${report.api?.requests ?? 0}**, points used: ${report.api?.pointsUsed ?? 0}, remaining: ${report.api?.remaining ?? '—'}`,
    `- Stop reason: ${report.stopReason || 'steps completed'}`,
    `- Runtime: ${report.runtimeSeconds}s`,
    '',
    '| Step | Result |',
    '| :-- | :-- |',
    ...Object.entries(report.steps || {}).map(([name, value]) => `| ${name} | \`${JSON.stringify(value)}\` |`),
    '',
    `- Repositories seen: ${report.counters.repositoriesSeen} (attributed ${report.counters.repositoriesAttributed}, ambiguous ${report.counters.ambiguousLocations}, unknown ${report.counters.unknownLocations})`,
    `- Accounts seen: ${report.counters.accountsSeen} (attributed users ${report.counters.accountsAttributed})`,
    `- Registry events: \`${JSON.stringify(report.registryEvents || {})}\``,
    '',
    '| Mode | Published | Provisional | Building | Stale | No results | Blocked | Ranked entries |',
    '| :-- | --: | --: | --: | --: | --: | --: | --: |',
    ...Object.entries(report.publication?.counts || {}).map(([mode, c]) =>
      `| ${mode} | ${c.published} | ${c.provisional} | ${c.building} | ${c.stale} | ${c.empty} | ${c.blocked} | ${report.publication.entries[mode]} |`),
    '',
  ];
  if (report.failures?.length) {
    lines.push('### Failures', '', ...report.failures.map((failure) => `- **${failure.step}**: ${failure.error}`), '');
  }
  return lines.join('\n');
}
