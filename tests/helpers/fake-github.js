// A small in-memory GitHub GraphQL fake that enforces the real search
// constraints GitSphere depends on: a 1,000-result window, 100-per-page
// cursors, qualifier semantics (stars/followers/repos/created/location/type)
// and `nodes(ids:)` returning null for deleted objects.

export function createFakeGitHub({ repositories = [], users = [], remaining = 4500, failures = {} } = {}) {
  const repos = new Map(repositories.map((repo) => [repo.id, repo]));
  const accounts = new Map(users.map((user) => [user.id, user]));
  const calls = { total: 0, byOperation: {} };
  let remainingPoints = remaining;

  const ownerNode = (login) => {
    const owner = [...accounts.values()].find((account) => account.login === login);
    if (!owner) return { __typename: 'User', id: `U_${login}`, login, name: null, location: null, followers: { totalCount: 0 } };
    return { __typename: owner.type || 'User', id: owner.id, databaseId: owner.databaseId ?? null, login: owner.login, name: owner.name ?? null, location: owner.location ?? null, followers: { totalCount: owner.followers || 0 } };
  };
  const repoNode = (repo) => ({
    __typename: 'Repository',
    id: repo.id,
    databaseId: null,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description ?? null,
    stargazerCount: repo.stars,
    forkCount: repo.forks || 0,
    isArchived: Boolean(repo.archived),
    isFork: Boolean(repo.fork),
    isPrivate: Boolean(repo.private),
    createdAt: repo.createdAt,
    pushedAt: repo.createdAt,
    primaryLanguage: repo.language ? { name: repo.language } : null,
    licenseInfo: null,
    owner: ownerNode(repo.owner),
  });
  const userNode = (user) => ({
    __typename: user.type || 'User',
    id: user.id,
    databaseId: user.databaseId ?? null,
    login: user.login,
    name: user.name ?? null,
    location: user.location ?? null,
    createdAt: user.createdAt,
    followers: { totalCount: user.followers || 0 },
    repositories: { totalCount: user.publicRepos || 0 },
    topRepositories: { nodes: [...repos.values()].filter((repo) => repo.owner === user.login && !repo.fork).sort((a, b) => b.stars - a.stars).slice(0, 1).map(repoNode) },
  });

  function rangeMatch(qualifier, value, text) {
    const match = text.match(new RegExp(`\\b${qualifier}:(\\S+)`));
    if (!match) return true;
    const [min, max] = match[1].includes('..') ? match[1].split('..') : [match[1], match[1]];
    if (qualifier === 'created') return value >= min && value <= max;
    return value >= Number(min) && value <= Number(max);
  }

  function searchRepositories(query) {
    return [...repos.values()]
      .filter((repo) => !repo.fork && !repo.private && !repo.deleted)
      .filter((repo) => rangeMatch('stars', repo.stars, query) && rangeMatch('created', repo.createdAt, query))
      .sort((a, b) => b.stars - a.stars || a.id.localeCompare(b.id));
  }

  function searchAccounts(query) {
    const location = query.match(/location:"([^"]*)"/)?.[1]?.toLowerCase();
    const type = query.match(/type:(user|org)/)?.[1];
    return [...accounts.values()]
      .filter((user) => !user.deleted)
      .filter((user) => !type || (type === 'org' ? user.type === 'Organization' : (user.type || 'User') === 'User'))
      .filter((user) => !location || ` ${String(user.location || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `.includes(` ${location} `))
      .filter((user) => rangeMatch('followers', user.followers || 0, query) && rangeMatch('repos', user.publicRepos || 0, query) && rangeMatch('created', user.createdAt, query))
      .sort((a, b) => (b.followers || 0) - (a.followers || 0) || a.id.localeCompare(b.id));
  }

  function page(items, first, cursor, map) {
    const offset = cursor ? Number(cursor) : 0;
    const accessible = items.slice(0, 1000);
    const slice = accessible.slice(offset, offset + first);
    const end = offset + slice.length;
    return {
      pageInfo: { hasNextPage: end < accessible.length, endCursor: String(end) },
      nodes: slice.map(map),
    };
  }

  async function fetchImpl(url, init) {
    const { query, variables } = JSON.parse(init.body);
    const operation = query.match(/query (\w+)/)?.[1] || 'anonymous';
    calls.total += 1;
    calls.byOperation[operation] = (calls.byOperation[operation] || 0) + 1;
    remainingPoints -= 1;
    const failure = failures[operation]?.shift?.();
    if (failure) return response(failure.status, failure.body || { message: failure.message || 'failure' }, failure.headers);

    const rateLimit = { cost: 1, limit: 5000, remaining: remainingPoints, resetAt: '2030-01-01T00:00:00Z' };
    let data;
    if (operation === 'GitSphereSearchRepositories') {
      const items = searchRepositories(variables.query);
      data = { search: { repositoryCount: items.length, ...page(items, variables.first, variables.cursor, repoNode) } };
    } else if (operation === 'GitSphereSearchAccounts') {
      const items = searchAccounts(variables.query);
      data = { search: { userCount: items.length, ...page(items, variables.first, variables.cursor, userNode) } };
    } else if (operation === 'GitSphereRepositoryNodes') {
      data = { nodes: variables.ids.map((id) => (repos.get(id) && !repos.get(id).deleted ? repoNode(repos.get(id)) : null)) };
    } else if (operation === 'GitSphereAccountNodes') {
      data = { nodes: variables.ids.map((id) => (accounts.get(id) && !accounts.get(id).deleted ? userNode(accounts.get(id)) : null)) };
    } else if (operation === 'GitSphereOwnerRepositories') {
      data = { nodes: variables.ids.map((id) => {
        const owner = accounts.get(id);
        if (!owner) return null;
        return { __typename: owner.type || 'User', id, repositories: { nodes: [...repos.values()].filter((repo) => repo.owner === owner.login && !repo.fork).sort((a, b) => b.stars - a.stars).slice(0, variables.first).map(repoNode) } };
      }) };
    } else if (operation === 'GitSphereContributions') {
      data = { nodes: variables.ids.map((id) => {
        const user = accounts.get(id);
        if (!user || user.deleted) return null;
        const c = user.contributions || { calendar: 0, restricted: 0 };
        return { ...userNode(user), contributionsCollection: {
          startedAt: variables.from, endedAt: variables.to,
          totalCommitContributions: c.commits || 0, totalIssueContributions: c.issues || 0,
          totalPullRequestContributions: c.pullRequests || 0, totalPullRequestReviewContributions: c.reviews || 0,
          totalRepositoryContributions: 0, restrictedContributionsCount: c.restricted || 0,
          contributionCalendar: { totalContributions: c.calendar || 0 },
        } };
      }) };
    } else if (operation === 'GitSphereRepositoriesByName') {
      data = {};
      for (const match of query.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)) {
        const repo = [...repos.values()].find((item) => item.owner.toLowerCase() === match[2].toLowerCase() && item.name.toLowerCase() === match[3].toLowerCase() && !item.deleted);
        data[match[1]] = repo ? repoNode(repo) : null;
      }
    } else {
      return response(400, { message: `unsupported operation ${operation}` });
    }
    return response(200, { data: { ...data, rateLimit } }, { 'x-ratelimit-remaining': String(remainingPoints), 'x-ratelimit-limit': '5000' });
  }

  return { fetchImpl, calls, repos, accounts };
}

function response(status, body, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

/** Deterministic pseudo-random generator for reproducible fixtures. */
export function seeded(seed = 42) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export const noSleep = async () => {};
