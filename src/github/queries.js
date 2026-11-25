// GraphQL documents used by GitSphere. Field selections are deliberately
// minimal: only what ranking, attribution and display require is requested,
// which also limits how much untrusted metadata enters the pipeline.

const REPOSITORY_FIELDS = `
  fragment GitSphereRepository on Repository {
    __typename
    id
    databaseId
    nameWithOwner
    description
    stargazerCount
    forkCount
    isArchived
    isFork
    isPrivate
    createdAt
    pushedAt
    primaryLanguage { name }
    licenseInfo { spdxId }
    owner {
      __typename
      id
      login
      ... on User { databaseId name location followers { totalCount } }
      ... on Organization { databaseId name location }
    }
  }
`;

const USER_FIELDS = `
  fragment GitSphereUser on User {
    id
    databaseId
    login
    name
    location
    createdAt
    followers { totalCount }
    repositories(ownerAffiliations: OWNER, privacy: PUBLIC) { totalCount }
  }
`;

const ORGANIZATION_FIELDS = `
  fragment GitSphereOrganization on Organization {
    id
    databaseId
    login
    name
    location
    repositories(privacy: PUBLIC) { totalCount }
  }
`;

const ACCOUNT_FIELDS = `${USER_FIELDS}${ORGANIZATION_FIELDS}`;

const RATE_LIMIT = 'rateLimit { cost limit remaining resetAt }';

export const SEARCH_REPOSITORIES = `
  query GitSphereSearchRepositories($query: String!, $first: Int!, $cursor: String) {
    search(type: REPOSITORY, query: $query, first: $first, after: $cursor) {
      repositoryCount
      pageInfo { hasNextPage endCursor }
      nodes { __typename ...GitSphereRepository }
    }
    ${RATE_LIMIT}
  }
  ${REPOSITORY_FIELDS}
`;

export const SEARCH_ACCOUNTS = `
  query GitSphereSearchAccounts($query: String!, $first: Int!, $cursor: String, $withTopRepository: Boolean!) {
    search(type: USER, query: $query, first: $first, after: $cursor) {
      userCount
      pageInfo { hasNextPage endCursor }
      nodes {
        __typename
        ... on User {
          ...GitSphereUser
          topRepositories: repositories(
            first: 1, ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false,
            orderBy: { field: STARGAZERS, direction: DESC }
          ) @include(if: $withTopRepository) { nodes { ...GitSphereRepository } }
        }
        ... on Organization {
          ...GitSphereOrganization
          topRepositories: repositories(
            first: 1, privacy: PUBLIC, isFork: false,
            orderBy: { field: STARGAZERS, direction: DESC }
          ) @include(if: $withTopRepository) { nodes { ...GitSphereRepository } }
        }
      }
    }
    ${RATE_LIMIT}
  }
  ${ACCOUNT_FIELDS}
  ${REPOSITORY_FIELDS}
`;

export const NODES_REPOSITORIES = `
  query GitSphereRepositoryNodes($ids: [ID!]!) {
    nodes(ids: $ids) { __typename ... on Repository { ...GitSphereRepository } }
    ${RATE_LIMIT}
  }
  ${REPOSITORY_FIELDS}
`;

export const NODES_ACCOUNTS = `
  query GitSphereAccountNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on User { ...GitSphereUser }
      ... on Organization { ...GitSphereOrganization }
    }
    ${RATE_LIMIT}
  }
  ${ACCOUNT_FIELDS}
`;

export const OWNER_REPOSITORIES = `
  query GitSphereOwnerRepositories($ids: [ID!]!, $first: Int!) {
    nodes(ids: $ids) {
      __typename
      ... on User {
        id
        repositories(first: $first, ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false,
          orderBy: { field: STARGAZERS, direction: DESC }) { nodes { ...GitSphereRepository } }
      }
      ... on Organization {
        id
        repositories(first: $first, privacy: PUBLIC, isFork: false,
          orderBy: { field: STARGAZERS, direction: DESC }) { nodes { ...GitSphereRepository } }
      }
    }
    ${RATE_LIMIT}
  }
  ${REPOSITORY_FIELDS}
`;

// Public contribution activity. GitHub documents contributionCalendar
// .totalContributions as the calendar total, and restrictedContributionsCount
// as "contributions made by the user that the viewer cannot access", non-zero
// only when the user shares private contribution counts. GitSphere ranks by
// calendar total minus restricted contributions, i.e. public activity only.
export const CONTRIBUTIONS = `
  query GitSphereContributions($ids: [ID!]!, $from: DateTime!, $to: DateTime!) {
    nodes(ids: $ids) {
      __typename
      ... on User {
        ...GitSphereUser
        contributionsCollection(from: $from, to: $to) {
          startedAt
          endedAt
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
          totalRepositoryContributions
          restrictedContributionsCount
          contributionCalendar { totalContributions }
        }
      }
    }
    ${RATE_LIMIT}
  }
  ${USER_FIELDS}
`;

export const SCHEMA_INTROSPECTION = `
  query GitSphereSchemaCheck {
    collection: __type(name: "ContributionsCollection") { fields { name description } }
    calendar: __type(name: "ContributionCalendar") { fields { name description } }
    ${RATE_LIMIT}
  }
`;

/** Aliased lookups that resolve legacy (name-only) records to node IDs. */
export function repositoriesByName(names) {
  const fields = names.map((name, index) => {
    const [owner, repo] = name.split('/');
    return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { ...GitSphereRepository }`;
  });
  return `query GitSphereRepositoriesByName { ${fields.join('\n')} ${RATE_LIMIT} } ${REPOSITORY_FIELDS}`;
}
