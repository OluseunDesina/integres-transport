import type { SelectOption, StatusPillTone } from '@shared-ui';

/**
 * Human labels, pill tones and the legal next statuses for a Route —
 * docs/specs/19-route-lifecycle.md.
 *
 * One place, because `route-list` (the filter, the pill, the row menu)
 * and `route-detail` (the pill, the status actions) all render the same
 * enumeration. **Every pill carries its label as text** — colour is
 * never the only status indicator.
 */

export type RouteStatus = 'draft' | 'active' | 'inactive' | 'archived';

const STATUS_LABELS: Record<RouteStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  inactive: 'Inactive',
  archived: 'Archived',
};

const STATUS_TONES: Record<RouteStatus, StatusPillTone> = {
  draft: 'neutral',
  active: 'positive',
  inactive: 'warning',
  archived: 'neutral',
};

/**
 * Mirrors `apps.network.services.ROUTE_TRANSITIONS` client-side — no
 * shared code with the backend, just the same legal-next-status shape,
 * so the row menu and the detail screen only ever offer a move the
 * backend will actually accept.
 *
 * **This is a duplicate and cannot be kept in sync by a test** — the two
 * live in different languages. Acceptable only because it is a
 * convenience, never the enforcement: the backend is authoritative and
 * answers 400 (illegal transition) or 409 (guard refused — no fare, too
 * few stops, a future trip) on anything this gets wrong, and every
 * caller renders that message inline rather than trusting this list.
 */
const ROUTE_TRANSITIONS: Record<RouteStatus, readonly RouteStatus[]> = {
  draft: ['active', 'archived'],
  active: ['inactive', 'archived'],
  inactive: ['active', 'archived'],
  archived: ['inactive'],
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as RouteStatus] ?? status;
}

export function statusTone(status: string): StatusPillTone {
  return STATUS_TONES[status as RouteStatus] ?? 'neutral';
}

export function nextStatuses(current: string): readonly RouteStatus[] {
  return ROUTE_TRANSITIONS[current as RouteStatus] ?? [];
}

/** "Restore" reads better than "Deactivate" when the route is coming
 * back from `archived` — same transition target (`inactive`), different
 * story depending on where it came from. */
export function transitionLabel(from: string, to: RouteStatus): string {
  if (to === 'inactive' && from === 'archived') {
    return 'Restore';
  }
  return { active: 'Activate', inactive: 'Deactivate', archived: 'Archive', draft: 'Restart' }[
    to
  ];
}

/**
 * Whether a transition takes the route further from being sold, versus
 * bringing it closer — used for both the row menu's icon/danger tone and
 * the confirm dialog's. `archived -> inactive` (restore) targets the
 * same status as `active -> inactive` (deactivate) but is not a "taking
 * out of service" move, so this needs `from` as well as `to`; `target`
 * alone conflates the two.
 */
export function takesOutOfService(from: string, to: RouteStatus): boolean {
  if (to === 'inactive' && from === 'archived') {
    return false;
  }
  return to === 'archived' || to === 'inactive';
}

function toOptions(labels: Record<string, string>, allLabel: string): SelectOption[] {
  return [
    { value: '', label: allLabel },
    ...Object.entries(labels).map(([value, label]) => ({ value, label })),
  ];
}

/** The blank option omits `?status=` entirely, which the backend reads
 * as "every status except archived" — not "every status". Selecting
 * "Archived" explicitly is the only way to reach one. */
export const STATUS_FILTER_OPTIONS = toOptions(STATUS_LABELS, 'All statuses');
