// Per-origin host access for Replay (PRD §6.3.5, §9.2).
//
// The manifest asks for no host access at install. Replay needs to reach
// the captured request's origin from the extension context, so the first
// Replay against an origin asks Chrome for exactly `<origin>/*`. Grants
// are listed in Settings → Privacy and can be revoked there.
//
// chrome.permissions.request must run inside the click's user gesture:
// call requestOriginAccess before any other await in the handler. It
// resolves true without a prompt when the origin is already granted.

/** Captured request URLs can be relative (`fetch('/api/x')`); resolve them
 *  against the page URL the event was captured on. */
export function absoluteUrl(url: string, pageUrl: string): string {
  try {
    return new URL(url, pageUrl).href;
  } catch {
    return url;
  }
}

/** `https://api.example.com/v1/x?y` → `https://api.example.com/*`. Null for non-http(s). */
export function originPattern(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return `${u.origin}/*`;
}

const SINGLE_ORIGIN = /^https?:\/\/[^*/]+\/\*$/;

export async function requestOriginAccess(url: string): Promise<boolean> {
  const pattern = originPattern(url);
  if (!pattern) return false;
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

/** Single-origin patterns granted at runtime, sorted. Wildcards such as the
 *  content scripts' `<all_urls>` are not Replay grants and are left out. */
export async function listGrantedOrigins(): Promise<string[]> {
  try {
    const all = await chrome.permissions.getAll();
    return (all.origins ?? []).filter((o) => SINGLE_ORIGIN.test(o)).sort();
  } catch {
    return [];
  }
}

export async function revokeOrigin(pattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.remove({ origins: [pattern] });
  } catch {
    return false;
  }
}
