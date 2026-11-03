// Friendly one-line label for a network request row.
//
// Raw URLs like /graphql or /AccountingApi/V2/api/GeneralSetting/GetDefault
// are hard to scan in the side-panel list. This derives a readable label:
//   - GraphQL  → "query GetUser" / "mutation Login" / "GraphQL (3 ops)"
//   - otherwise → the path (+ query string), via the caller's shortener.
//
// Pure + dependency-free so it's unit-tested in isolation.

const GQL_OP = /\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * If the request looks like GraphQL, return a readable operation label;
 * otherwise null (caller falls back to the URL path).
 */
export function graphqlLabel(url: string, body: string | null): string | null {
  const looksGraphql = /\/graphql\b/i.test(url) || (body != null && /["']query["']\s*:/.test(body));
  if (!looksGraphql || !body) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  // Batched requests: an array of operations.
  if (Array.isArray(parsed)) {
    const names = parsed.map((op) => opLabel(op)).filter(Boolean);
    if (names.length === 0) return null;
    if (names.length === 1) return names[0]!;
    return `GraphQL · ${names.length} ops`;
  }
  return opLabel(parsed);
}

function opLabel(op: unknown): string | null {
  if (op == null || typeof op !== 'object') return null;
  const rec = op as { query?: unknown; operationName?: unknown };
  const query = typeof rec.query === 'string' ? rec.query : '';
  const named = typeof rec.operationName === 'string' ? rec.operationName.trim() : '';

  const m = query.match(GQL_OP);
  if (m) {
    const type = m[1];
    const name = named || m[2];
    return `${type} ${name}`;
  }
  if (named) return named;
  // Anonymous query (`{ ... }`) with no operation name.
  if (query.trim().startsWith('{')) return 'query (anonymous)';
  return null;
}
