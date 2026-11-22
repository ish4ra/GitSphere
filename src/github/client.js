import { USER_AGENT } from '../core/identity.js';
import { safeErrorMessage } from '../core/sanitize.js';

const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

export class GitHubBudgetError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'GitHubBudgetError';
    this.reason = reason; // 'request-budget' | 'rate-limit-reserve' | 'primary-rate-limit' | 'secondary-rate-limit'
  }
}

/**
 * GraphQL client with explicit API-budget accounting.
 *
 * - Primary rate limit: tracked from `rateLimit` / x-ratelimit-* headers;
 *   the client refuses to spend below `rateLimitReserve` points.
 * - Secondary rate limits (403/429 + retry-after or "secondary rate limit"):
 *   honoured with bounded waiting, then surfaced as GitHubBudgetError so the
 *   caller checkpoints and stops instead of hammering the API.
 * - Transient failures (5xx, timeouts, "Something went wrong"): retried with
 *   exponential backoff.
 */
export class GitHubClient {
  constructor({
    token,
    fetchImpl = globalThis.fetch,
    maxRequests = 500,
    rateLimitReserve = 200,
    maxSecondaryWaitMs = 5 * 60 * 1000,
    requestTimeoutMs = 45_000,
    minimumIntervalMs = 250,
    sleep = defaultSleep,
    now = () => Date.now(),
    log = console,
  } = {}) {
    if (!token) throw new Error('A GitHub token is required. Set GITHUB_TOKEN or GH_TOKEN.');
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
    this.token = token;
    this.fetch = fetchImpl;
    this.maxRequests = maxRequests;
    this.rateLimitReserve = rateLimitReserve;
    this.maxSecondaryWaitMs = maxSecondaryWaitMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.minimumIntervalMs = minimumIntervalMs;
    this.sleep = sleep;
    this.now = now;
    this.log = log;
    this.stats = {
      requests: 0,
      pointsUsed: 0,
      retries: 0,
      secondaryWaitMs: 0,
      remaining: null,
      limit: null,
      resetAt: null,
    };
    this.lastRequestAt = 0;
  }

  /** True when another request fits in both the run budget and the reserve. */
  canSpend(requests = 1) {
    if (this.stats.requests + requests > this.maxRequests) return false;
    if (Number.isFinite(this.stats.remaining) && this.stats.remaining - requests < this.rateLimitReserve) return false;
    return true;
  }

  stopReason() {
    if (this.stats.requests >= this.maxRequests) return 'request-budget';
    if (Number.isFinite(this.stats.remaining) && this.stats.remaining < this.rateLimitReserve) return 'rate-limit-reserve';
    return null;
  }

  async graphql(query, variables = {}, { allowPartialErrors = false } = {}) {
    if (!this.canSpend()) {
      throw new GitHubBudgetError(`API budget exhausted (${this.stopReason()}).`, this.stopReason());
    }

    const maxAttempts = 5;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await this.#pace();
      let response;
      let body;
      try {
        response = await this.#post(query, variables);
        this.stats.requests += 1;
        this.#trackHeaders(response.headers);
        body = await response.json().catch(() => null);
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts) break;
        this.stats.retries += 1;
        await this.sleep(backoff(attempt));
        continue;
      }

      const messages = [body?.message, ...(body?.errors || []).map((item) => item?.message)]
        .filter(Boolean)
        .join('; ');

      if (response.status === 403 || response.status === 429 || /secondary rate limit|abuse/i.test(messages)) {
        const remaining = Number(response.headers.get('x-ratelimit-remaining'));
        if (remaining === 0 && !/secondary/i.test(messages)) {
          throw new GitHubBudgetError('Primary GraphQL rate limit exhausted.', 'primary-rate-limit');
        }
        const retryAfter = Number(response.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000 * attempt;
        if (this.stats.secondaryWaitMs + waitMs > this.maxSecondaryWaitMs || attempt === maxAttempts) {
          throw new GitHubBudgetError('Secondary rate limit persisted; stopping safely.', 'secondary-rate-limit');
        }
        this.log.warn?.(`Secondary rate limit; waiting ${Math.round(waitMs / 1000)}s.`);
        this.stats.secondaryWaitMs += waitMs;
        this.stats.retries += 1;
        await this.sleep(waitMs);
        continue;
      }

      if (body?.errors?.some((item) => item?.type === 'RATE_LIMITED')) {
        throw new GitHubBudgetError('GraphQL RATE_LIMITED error.', 'primary-rate-limit');
      }

      if (response.status >= 500 || (!body?.data && /something went wrong|timeout|timed out/i.test(messages))) {
        lastError = new Error(`GitHub GraphQL transient failure (HTTP ${response.status}).`);
        lastError.status = response.status;
        lastError.transient = true;
        if (attempt === maxAttempts) break;
        this.stats.retries += 1;
        await this.sleep(backoff(attempt));
        continue;
      }

      if (!response.ok) {
        const error = new Error(`GitHub GraphQL HTTP ${response.status}: ${safeErrorMessage({ message: messages })}`);
        error.status = response.status;
        throw error;
      }

      this.#trackRateLimit(body?.data?.rateLimit);

      if (body?.errors?.length) {
        const fatal = body.errors.filter((item) => !(allowPartialErrors && item?.type === 'NOT_FOUND'));
        if (fatal.length || !body.data) {
          const error = new Error(`GitHub GraphQL error: ${safeErrorMessage({ message: messages })}`);
          error.graphqlErrors = body.errors.map((item) => ({ type: item?.type || null, path: item?.path || null }));
          throw error;
        }
      }
      if (!body?.data) {
        lastError = new Error('GitHub GraphQL returned no data.');
        if (attempt === maxAttempts) break;
        await this.sleep(backoff(attempt));
        continue;
      }
      return { data: body.data, errors: body.errors || [] };
    }
    throw lastError;
  }

  async #post(query, variables) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetch(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async #pace() {
    const elapsed = this.now() - this.lastRequestAt;
    if (this.lastRequestAt && elapsed < this.minimumIntervalMs) {
      await this.sleep(this.minimumIntervalMs - elapsed);
    }
    this.lastRequestAt = this.now();
  }

  #trackHeaders(headers) {
    const remaining = Number(headers?.get?.('x-ratelimit-remaining'));
    const limit = Number(headers?.get?.('x-ratelimit-limit'));
    if (headers?.get?.('x-ratelimit-remaining') != null && Number.isFinite(remaining)) {
      this.stats.remaining = remaining;
    }
    if (headers?.get?.('x-ratelimit-limit') != null && Number.isFinite(limit)) this.stats.limit = limit;
  }

  #trackRateLimit(rateLimit) {
    if (!rateLimit) return;
    if (Number.isFinite(rateLimit.remaining)) this.stats.remaining = rateLimit.remaining;
    if (Number.isFinite(rateLimit.limit)) this.stats.limit = rateLimit.limit;
    if (Number.isFinite(rateLimit.cost)) this.stats.pointsUsed += rateLimit.cost;
    if (rateLimit.resetAt) this.stats.resetAt = rateLimit.resetAt;
  }
}

function backoff(attempt) {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
