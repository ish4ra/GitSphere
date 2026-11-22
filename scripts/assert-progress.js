#!/usr/bin/env node
// Exits non-zero when the last pipeline run made no useful progress.
import { projectRoot } from '../src/config.js';
import { readRunReport } from '../src/pipeline/run.js';

const report = await readRunReport(projectRoot());
if (!report) {
  console.error('::error::No pipeline run report found.');
  process.exit(1);
}
console.log(`Progress: ${report.progress?.ok ? 'yes' : 'no'} (${report.progress?.reason}); requests=${report.api?.requests ?? 0}`);
if (!report.progress?.ok) {
  console.error(`::error::GitSphere pipeline stalled: ${report.progress?.reason}`);
  process.exit(1);
}
