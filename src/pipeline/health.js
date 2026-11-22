// Long-horizon health checks. A run can make progress every hour while the
// rankings still stop improving (for example a scan cycle that never
// completes). These checks turn that into a visible failure instead of
// weeks of green workflow runs.

export const HEALTH_LIMITS = Object.freeze({
  cycleOverdueDays: 14,
  completedCycleMaxAgeDays: 21,
});

export function evaluateHealth({ repositoryScan, followerScan, now, limits = HEALTH_LIMITS }) {
  const issues = [];
  const day = 86_400_000;
  for (const [name, scan] of [['repositories', repositoryScan], ['followers', followerScan]]) {
    if (!scan?.cycleStartedAt) continue;
    const running = Date.parse(now) - Date.parse(scan.cycleStartedAt);
    const last = scan.completedCycles?.at(-1) || null;
    if (scan.queue?.length && running > limits.cycleOverdueDays * day) {
      issues.push(`${name}-cycle-overdue: cycle ${scan.cycle} has run ${Math.floor(running / day)} days without completing`);
    }
    if (last && Date.parse(now) - Date.parse(last.completedAt) > limits.completedCycleMaxAgeDays * day && scan.queue?.length) {
      issues.push(`${name}-certification-expiring: last completed cycle finished ${Math.floor((Date.parse(now) - Date.parse(last.completedAt)) / day)} days ago`);
    }
  }
  return { ok: issues.length === 0, issues };
}
