import { describe, expect, it } from 'vitest';

import { graphqlLabel } from './request-label';

describe('graphqlLabel', () => {
  it('labels a named query from the query string', () => {
    const body = JSON.stringify({ query: 'query GetUser($id: ID!) { user(id:$id){ name } }' });
    expect(graphqlLabel('https://api.x.com/graphql', body)).toBe('query GetUser');
  });

  it('labels a mutation', () => {
    const body = JSON.stringify({ query: 'mutation Login { login { token } }' });
    expect(graphqlLabel('https://api.x.com/graphql', body)).toBe('mutation Login');
  });

  it('prefers operationName when present', () => {
    const body = JSON.stringify({
      query: 'query Q { a }',
      operationName: 'FetchDashboard',
    });
    expect(graphqlLabel('https://api.x.com/graphql', body)).toBe('query FetchDashboard');
  });

  it('detects GraphQL by body shape even without /graphql in the URL', () => {
    const body = JSON.stringify({ query: 'query Ping { ping }' });
    expect(graphqlLabel('https://api.x.com/gateway', body)).toBe('query Ping');
  });

  it('summarises batched operations', () => {
    const body = JSON.stringify([
      { query: 'query A { a }' },
      { query: 'query B { b }' },
      { query: 'mutation C { c }' },
    ]);
    expect(graphqlLabel('https://api.x.com/graphql', body)).toBe('GraphQL · 3 ops');
  });

  it('labels an anonymous query', () => {
    const body = JSON.stringify({ query: '{ viewer { id } }' });
    expect(graphqlLabel('https://api.x.com/graphql', body)).toBe('query (anonymous)');
  });

  it('returns null for non-GraphQL requests', () => {
    expect(graphqlLabel('https://api.x.com/v1/users', '{"name":"x"}')).toBeNull();
    expect(graphqlLabel('https://api.x.com/graphql', null)).toBeNull();
    expect(graphqlLabel('https://api.x.com/graphql', 'not json')).toBeNull();
  });
});
