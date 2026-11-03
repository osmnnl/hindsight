// Detection rule engine — PRD §6.2.1.
//
// Pure functions that look at a newly-emitted CapturedEvent in the
// context of the recent buffer and decide whether to mark it with
// EventFlag values. Runs in the service worker on every queueEvent
// call, before persistence, so the meta.flags / meta.cascadeOf
// fields are stamped exactly once and ride along with the event for
// the rest of its lifetime.
//
// Tests: detection.test.ts.

import {
  isFailedNetwork,
  type CapturedEvent,
  type EventFlag,
  type NetworkFetchEvent,
  type NetworkXhrEvent,
} from '@/types/events';

type NetworkRequestEvent = NetworkFetchEvent | NetworkXhrEvent;

/** PRD §6.2.1: duration > 3000 ms surfaces as a yellow badge. */
export const SLOW_REQUEST_MS = 3000;

/** PRD §6.2.1 cascade rule: three failed requests to the same origin
 *  and failure class (see failureClass) within ten seconds count as one
 *  cascade. */
export const CASCADE_WINDOW_MS = 10_000;
export const CASCADE_MIN_COUNT = 3;

export interface DetectionResult {
  /** Flags to merge into event.meta.flags. Empty when no rule fired. */
  flags: EventFlag[];
  /** When set, marks this event as part of an existing cascade. The
   *  value is the cascade-head event id. New cascades return their own
   *  head id here as soon as the threshold is crossed. */
  cascadeOf?: string;
}

/**
 * Runs the detection rule engine against `event` using `buffer` (the
 * recent events already in storage, oldest-first). The buffer should
 * NOT yet contain `event` itself — we're deciding what to stamp before
 * it lands. Idempotent: running it again with the same inputs returns
 * the same result.
 */
export function detect(event: CapturedEvent, buffer: CapturedEvent[]): DetectionResult {
  const flags: EventFlag[] = [];
  let cascadeOf: string | undefined;

  if (isFailedNetwork(event)) flags.push('failed');
  if (event.type === 'console.error' || event.type === 'console.unhandled') flags.push('failed');

  if (event.type === 'network.fetch' || event.type === 'network.xhr') {
    if (event.data.timing.durationMs > SLOW_REQUEST_MS) flags.push('slow');
  }

  // Cascade detection: count recent failed network events to the same
  // origin within the window. CASCADE_MIN_COUNT includes `event` itself
  // so a freshly-arriving third failure crosses the threshold.
  if (isFailedNetwork(event)) {
    const cascade = detectCascade(event, buffer);
    if (cascade) {
      if (!flags.includes('cascade-member')) flags.push('cascade-member');
      if (cascade.isHead) flags.push('cascade-head');
      cascadeOf = cascade.headId;
    }
  }

  // Repeated identical failure: same method + url + status seen twice or
  // more becomes 'anomaly'. Catches retry loops and flaky endpoints.
  if (isFailedNetwork(event)) {
    const duplicates = countIdenticalFailures(event, buffer);
    if (duplicates >= 1) flags.push('anomaly');
  }

  return cascadeOf ? { flags, cascadeOf } : { flags };
}

// ---------------------------------------------------------------------------
// Cascade
// ---------------------------------------------------------------------------

interface CascadeMatch {
  headId: string;
  isHead: boolean;
}

function detectCascade(trigger: NetworkRequestEvent, buffer: CapturedEvent[]): CascadeMatch | null {
  const since = trigger.timestamp - CASCADE_WINDOW_MS;
  const key = cascadeKey(trigger);

  const recentSameOriginFailures = buffer
    .filter(
      (e): e is NetworkRequestEvent =>
        (e.type === 'network.fetch' || e.type === 'network.xhr') &&
        isFailedNetwork(e) &&
        e.timestamp >= since &&
        cascadeKey(e) === key
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  // Including `trigger` (not yet in buffer) brings the count to N+1.
  const total = recentSameOriginFailures.length + 1;
  if (total < CASCADE_MIN_COUNT) return null;

  // Reuse the existing head if any of the in-window failures already
  // carries a cascadeOf — otherwise the oldest failure is the head.
  const inheritedHead = recentSameOriginFailures
    .map((e) => e.meta?.cascadeOf)
    .find((h): h is string => !!h);
  if (inheritedHead) {
    return { headId: inheritedHead, isHead: false };
  }

  const oldest = recentSameOriginFailures[0];
  if (!oldest) return null;
  // First time the threshold trips: `oldest` is the cluster anchor
  // (cascadeOf points back at it), but the *triggering* event — the
  // one we're stamping right now — is what callers treat as the
  // cascade head. That's what fires the one-shot SW desktop
  // notification (background/service-worker.ts) and renders the
  // initial cluster banner (sidepanel). Subsequent in-window failures
  // hit the inheritedHead branch above with isHead:false and just
  // join the cluster.
  return { headId: oldest.id, isHead: true };
}

export type FailureClass = 'auth' | 'client' | 'server' | 'network';

/** Bucket a failed request so unrelated failures don't merge into one
 *  cascade: an expired session (401/403) is a different story from a
 *  backend outage (5xx) or a stray 404 on the same origin. */
export function failureClass(e: NetworkRequestEvent): FailureClass {
  const status = e.data.response.status;
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'network';
}

function cascadeKey(e: NetworkRequestEvent): string {
  return `${safeOrigin(e.data.request.url)} ${failureClass(e)}`;
}

/**
 * Cluster membership for rendering: member id → head id (heads aren't
 * keys). detect() can only stamp cascadeOf from the threshold-tripping
 * failure onward, so the failures between the head and that event (the
 * 2nd of 3) carry no link; this backfills them from the same cascade key
 * so the cluster count matches what the rule saw. `events` is
 * oldest-first.
 */
export function resolveClusters(events: readonly CapturedEvent[]): Map<string, string> {
  const byId = new Map<string, CapturedEvent>();
  for (const e of events) byId.set(e.id, e);
  const clusterOf = new Map<string, string>();
  for (let i = 0; i < events.length; i++) {
    const member = events[i]!;
    const headId = member.meta?.cascadeOf;
    if (!headId || headId === member.id) continue;
    const head = byId.get(headId);
    if (!head) continue;
    clusterOf.set(member.id, headId);
    if (!isFailedNetwork(head)) continue;
    const key = cascadeKey(head);
    for (let j = i - 1; j >= 0; j--) {
      const prior = events[j]!;
      if (prior.timestamp < head.timestamp) break;
      if (prior.id === headId || clusterOf.has(prior.id)) continue;
      if (isFailedNetwork(prior) && cascadeKey(prior) === key) clusterOf.set(prior.id, headId);
    }
  }
  return clusterOf;
}

function countIdenticalFailures(trigger: NetworkRequestEvent, buffer: CapturedEvent[]): number {
  return buffer.filter(
    (e): e is NetworkRequestEvent =>
      (e.type === 'network.fetch' || e.type === 'network.xhr') &&
      isFailedNetwork(e) &&
      e.data.request.method === trigger.data.request.method &&
      e.data.request.url === trigger.data.request.url &&
      e.data.response.status === trigger.data.response.status
  ).length;
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
