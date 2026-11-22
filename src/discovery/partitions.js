// Deterministic, resumable partitioning for GitHub search.
//
// GitHub search exposes at most 1,000 results per query. A partition is a
// (metric range, creation-time range) pair. When a partition reports more
// than 1,000 results it is split:
//   1. by metric (stars / followers / repos) while the range is wider than
//      one value — geometric bisection for wide ranges, arithmetic otherwise;
//   2. once the metric is a single value (an "exact bucket", e.g. stars:215),
//      by creation time, recursively bisecting down to `minCreatedSpanSeconds`.
// Children never overlap and always cover their parent exactly. A partition
// that still exceeds the window at the minimum time span is recorded as
// genuinely unresolved instead of being dropped.
//
// The previous implementation stopped at step 1 and parked >200 exact-star
// buckets (stars:1..215) as "unresolved" forever, which emptied its queue and
// left every scheduled run with nothing to do.

export const SEARCH_WINDOW = 1000;
export const GITHUB_EPOCH = '2007-10-01T00:00:00Z';
export const MAX_METRIC = 100_000_000;

export function createSpec({
  base,
  metric,
  sort,
  createdQualifier = 'created',
  minCreatedSpanSeconds = 60,
  origin = GITHUB_EPOCH,
}) {
  return { base, metric, sort, createdQualifier, minCreatedSpanSeconds, origin };
}

export function rootPartition({ min = 0, max = MAX_METRIC } = {}) {
  return { metric: [min, max], created: null, cursor: null, page: 1 };
}

export function buildQuery(spec, partition) {
  const [min, max] = partition.metric;
  const metric = min === max ? `${spec.metric}:${min}` : `${spec.metric}:${min}..${max}`;
  const created = partition.created
    ? ` ${spec.createdQualifier}:${partition.created[0]}..${partition.created[1]}`
    : '';
  return `${spec.base} ${metric}${created} sort:${spec.sort}`.replace(/\s+/g, ' ').trim();
}

/**
 * Splits a capped partition. Returns `{ children }` (highest metric first),
 * or `{ unresolved: reason }` when it cannot be split further.
 */
export function splitPartition(spec, partition, cycleStartedAt) {
  const [min, max] = partition.metric;
  if (min < max) {
    const mid = max / Math.max(1, min) > 4 && min > 0
      ? Math.floor(Math.sqrt(min * max))
      : Math.floor((min + max) / 2);
    const split = Math.min(Math.max(mid, min), max - 1);
    return {
      children: [
        { metric: [split + 1, max], created: partition.created, cursor: null, page: 1 },
        { metric: [min, split], created: partition.created, cursor: null, page: 1 },
      ],
    };
  }

  const [from, to] = partition.created
    ? partition.created.map(parseIso)
    : [parseIso(spec.origin), parseIso(cycleStartedAt)];
  const spanSeconds = (to - from) / 1000;
  if (!(spanSeconds > spec.minCreatedSpanSeconds)) {
    return { unresolved: 'search-window-exceeded-at-minimum-time-span' };
  }
  const midpoint = from + Math.floor((to - from) / 2000) * 1000;
  // Newer half first: within an exact bucket order is irrelevant for
  // ranking, and newer repositories are the ones most likely to be missed.
  return {
    children: [
      { metric: partition.metric, created: [formatIso(midpoint + 1000), formatIso(to)], cursor: null, page: 1 },
      { metric: partition.metric, created: [formatIso(from), formatIso(midpoint)], cursor: null, page: 1 },
    ],
  };
}

export function partitionKey(partition) {
  return `${partition.metric[0]}..${partition.metric[1]}|${partition.created ? partition.created.join('..') : '*'}`;
}

/** Highest metric value that is not yet fully enumerated in this cycle. */
export function frontier(queue) {
  let highest = null;
  for (const item of queue || []) {
    if (highest == null || item.metric[1] > highest) highest = item.metric[1];
  }
  return highest;
}

/**
 * Lowest metric value v such that every value >= v has been fully
 * enumerated: everything above the queue frontier and above every
 * unresolved partition.
 */
export function verifiedFloor({ queue, unresolved, floor }) {
  const open = frontier(queue);
  let level = open == null ? floor : open + 1;
  for (const item of unresolved || []) level = Math.max(level, item.metric[1] + 1);
  return level;
}

/**
 * Runs a partitioned scan until the queue is empty or `shouldContinue()`
 * returns false. State is mutated in place and `checkpoint()` is awaited after
 * every page, so an interrupted runner loses at most one page of work.
 *
 * @param {object} options
 * @param {object} options.state       { queue, unresolved, cycleStartedAt, stats }
 * @param {Function} options.fetchPage async (query, cursor) => { count, nodes, hasNextPage, endCursor }
 * @param {Function} options.onNodes   async (nodes, partition) => void
 */
export async function runPartitionedScan({
  spec,
  state,
  fetchPage,
  onNodes,
  shouldContinue = () => true,
  checkpoint = async () => {},
  pageSize = 100,
  log = console,
}) {
  const summary = { pages: 0, splits: 0, leaves: 0, unresolved: 0, nodes: 0, failures: 0 };
  state.unresolved ||= [];
  state.stats ||= {};

  while (state.queue.length && shouldContinue()) {
    const partition = state.queue[0];
    const query = buildQuery(spec, partition);
    let page;
    try {
      page = await fetchPage(query, partition.cursor, pageSize);
    } catch (error) {
      if (error?.name === 'GitHubBudgetError') throw error;
      partition.attempts = (partition.attempts || 0) + 1;
      summary.failures += 1;
      if (partition.attempts >= 3) {
        state.queue.shift();
        state.unresolved.push({ ...stripCursor(partition), reason: 'query-failed-repeatedly', recordedAt: new Date().toISOString() });
        summary.unresolved += 1;
        log.warn?.(`Recorded failing partition as unresolved: ${query}`);
      } else {
        // Rotate it to the back so one bad query cannot block the scan.
        state.queue.push(state.queue.shift());
      }
      await checkpoint();
      continue;
    }
    summary.pages += 1;

    if (!partition.cursor && page.count > SEARCH_WINDOW) {
      const result = splitPartition(spec, partition, state.cycleStartedAt);
      state.queue.shift();
      if (result.children) {
        state.queue.unshift(...result.children);
        summary.splits += 1;
        state.stats.splits = (state.stats.splits || 0) + 1;
      } else {
        state.unresolved.push({
          ...stripCursor(partition),
          reportedCount: page.count,
          reason: result.unresolved,
          recordedAt: new Date().toISOString(),
        });
        summary.unresolved += 1;
        log.warn?.(`Unresolvable partition (${page.count} results): ${query}`);
      }
      await checkpoint();
      continue;
    }

    const nodes = page.nodes || [];
    summary.nodes += nodes.length;
    await onNodes(nodes, partition);

    if (page.hasNextPage && page.endCursor && (partition.page || 1) * pageSize < SEARCH_WINDOW) {
      partition.cursor = page.endCursor;
      partition.page = (partition.page || 1) + 1;
      partition.attempts = 0;
    } else {
      state.queue.shift();
      summary.leaves += 1;
      state.stats.leaves = (state.stats.leaves || 0) + 1;
    }
    state.stats.pages = (state.stats.pages || 0) + 1;
    await checkpoint();
  }
  return summary;
}

function stripCursor(partition) {
  return { metric: partition.metric, created: partition.created };
}

function parseIso(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`Invalid partition timestamp: ${value}`);
  return Math.floor(time / 1000) * 1000;
}

export function formatIso(time) {
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
