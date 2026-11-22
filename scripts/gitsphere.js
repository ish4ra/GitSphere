#!/usr/bin/env node
// GitSphere command line.
//   node scripts/gitsphere.js pipeline   # bounded discovery + refresh + publish
//   node scripts/gitsphere.js publish    # regenerate pages/data from saved state
import { appendFile } from 'node:fs/promises';
import { projectRoot } from '../src/config.js';
import { runPipeline, settingsFromEnv } from '../src/pipeline/run.js';
import { renderJobSummary } from '../src/pipeline/summary.js';

const command = process.argv[2] || 'pipeline';
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const root = projectRoot();

if (!['pipeline', 'publish'].includes(command)) {
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}
if (command === 'pipeline' && !token) {
  console.error('GITHUB_TOKEN or GH_TOKEN is required for the pipeline.');
  process.exit(2);
}

const report = await runPipeline({ root, token, settings: settingsFromEnv(), skipApi: command === 'publish' });
const summary = renderJobSummary(report);
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
if (!report.progress.ok) {
  console.error(`::warning::GitSphere run did not make useful progress: ${report.progress.reason}`);
}
