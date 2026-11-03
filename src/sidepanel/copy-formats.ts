// Pure copy formatters split out of sidepanel.ts so they can be unit
// tested (1.0 C1: copy-as-fetch and the masked-token guard from PR #8).
import type { NetworkFetchEvent, NetworkXhrEvent } from '@/types/events';

type NetworkRequestEvent = NetworkFetchEvent | NetworkXhrEvent;

/** Reproduce the request as a runnable fetch() call — paste into a console
 *  or a .js file. */
export function toFetch(c: NetworkRequestEvent): string {
  const init: string[] = [`  method: ${JSON.stringify(c.data.request.method)}`];
  // Headers are already masked at capture time (PRD §11.2).
  const headers = c.data.request.headers;
  if (Object.keys(headers).length > 0) {
    init.push(`  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ')}`);
  }
  if (c.data.request.body != null && c.data.request.body !== '') {
    init.push(`  body: ${JSON.stringify(String(c.data.request.body))}`);
  }
  return `fetch(${JSON.stringify(c.data.request.url)}, {\n${init.join(',\n')},\n});`;
}

/** Pull the access token out of the Authorization header. Strips the
 *  scheme prefix (Bearer / Token / JWT) so the user can paste the raw
 *  credential into a JWT decoder, Postman, etc. If the header is masked
 *  (Authorization rule still enabled in Settings → Privacy) this
 *  returns ***MASKED***, which is honest about what storage holds. */
export function extractAccessToken(c: NetworkRequestEvent): string {
  const auth =
    c.data.request.headers['Authorization'] ?? c.data.request.headers['authorization'] ?? '';
  if (!auth) return '';
  const m = auth.match(/^\s*(Bearer|Token|JWT|Basic)\s+(.+)$/i);
  return m && m[2] ? m[2] : auth;
}
