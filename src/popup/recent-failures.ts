import type { CapturedEvent } from '@/types/events';
import { isFailedNetwork } from '@/types/events';

/** Recent failures for the popup list, newest first. A cascade (PRD
 *  §6.2.3) collapses into its head row with a member count, so one 401
 *  storm takes one line instead of three. */
export function recentFailures(
  events: CapturedEvent[],
  max: number
): Array<{ event: CapturedEvent; clusterSize: number }> {
  const failing = events.filter(
    (e) => isFailedNetwork(e) || e.type === 'console.error' || e.type === 'console.unhandled'
  );
  const membersOf = new Map<string, number>();
  for (const e of failing) {
    const head = e.meta?.cascadeOf;
    if (head) membersOf.set(head, (membersOf.get(head) ?? 0) + 1);
  }
  const out: Array<{ event: CapturedEvent; clusterSize: number }> = [];
  const ids = new Set(failing.map((e) => e.id));
  for (let i = failing.length - 1; i >= 0 && out.length < max; i--) {
    const e = failing[i]!;
    if (e.meta?.cascadeOf && ids.has(e.meta.cascadeOf)) continue;
    const members = membersOf.get(e.id) ?? 0;
    out.push({ event: e, clusterSize: members > 0 ? members + 1 : 1 });
  }
  return out;
}
