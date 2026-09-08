import type { SelectOption, StatusPillTone } from '@shared-ui';

/**
 * Human labels, pill tones and the legal next statuses for an incident.
 *
 * One place, because the queue, the detail screen and the dashboard
 * strip all render the same three enumerations, and three copies of a
 * colour map is how a status ends up meaning "good" on one screen and
 * "bad" on another.
 *
 * **Every pill carries its label as text.** Colour is never the only
 * status indicator — this repo's standing accessibility bar, and the
 * reason `ui-status-pill` requires `label`.
 */

export type IncidentStatus =
  | 'open'
  | 'acknowledged'
  | 'investigating'
  | 'resolved'
  | 'closed';

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';

const STATUS_LABELS: Record<IncidentStatus, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  investigating: 'Investigating',
  resolved: 'Resolved',
  closed: 'Closed',
};

const STATUS_TONES: Record<IncidentStatus, StatusPillTone> = {
  open: 'negative',
  acknowledged: 'warning',
  investigating: 'warning',
  resolved: 'positive',
  closed: 'neutral',
};

const SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

const SEVERITY_TONES: Record<IncidentSeverity, StatusPillTone> = {
  low: 'neutral',
  medium: 'neutral',
  high: 'warning',
  critical: 'negative',
};

const CATEGORY_LABELS: Record<string, string> = {
  hardware: 'Hardware',
  vehicle: 'Vehicle',
  safety: 'Safety',
  service: 'Service quality',
  gps: 'GPS / location',
  announcement: 'Stop announcement',
  other: 'Other',
};

const SOURCE_LABELS: Record<string, string> = {
  operator: 'Operator',
  passenger: 'Passenger',
};

/**
 * The lifecycle, mirroring `apps.incidents.services._ALLOWED_TRANSITIONS`.
 *
 * **This is a duplicate and cannot be kept in sync by a test** — the two
 * live in different languages. That is acceptable only because it is a
 * convenience, never the enforcement: the backend is authoritative and
 * answers 409 on an illegal move, and every caller renders that 409
 * inline. If the two drift, the worst case is a menu item that fails
 * with a readable message, not a state the server did not sanction.
 *
 * Both reopen paths are here on purpose — a fault reported fixed and
 * still broken is the normal case, and forcing a duplicate record loses
 * the history.
 */
const ALLOWED_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  open: ['acknowledged', 'investigating', 'resolved'],
  acknowledged: ['investigating', 'resolved'],
  investigating: ['resolved'],
  resolved: ['closed', 'investigating'],
  closed: ['investigating'],
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as IncidentStatus] ?? status;
}

export function statusTone(status: string): StatusPillTone {
  return STATUS_TONES[status as IncidentStatus] ?? 'neutral';
}

export function severityLabel(severity: string): string {
  return SEVERITY_LABELS[severity as IncidentSeverity] ?? severity;
}

export function severityTone(severity: string): StatusPillTone {
  return SEVERITY_TONES[severity as IncidentSeverity] ?? 'neutral';
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/** The statuses this incident may legally move to. Empty for an unknown
 * status rather than a guess — offering a move the server will refuse is
 * worse than offering none. */
export function nextStatuses(current: string): readonly IncidentStatus[] {
  return ALLOWED_TRANSITIONS[current as IncidentStatus] ?? [];
}

/** "Reopen" reads better than "Investigating" on a resolved or closed
 * incident — it is the same transition, but the operator is thinking
 * about the record, not the enum. */
export function transitionLabel(from: string, to: IncidentStatus): string {
  if (to === 'investigating' && (from === 'resolved' || from === 'closed')) {
    return 'Reopen';
  }
  return { acknowledged: 'Acknowledge', investigating: 'Investigate', resolved: 'Resolve', closed: 'Close', open: 'Reopen' }[to];
}

function toOptions(labels: Record<string, string>, allLabel: string): SelectOption[] {
  return [
    { value: '', label: allLabel },
    ...Object.entries(labels).map(([value, label]) => ({ value, label })),
  ];
}

export const STATUS_FILTER_OPTIONS = toOptions(STATUS_LABELS, 'Any status');
export const SEVERITY_FILTER_OPTIONS = toOptions(SEVERITY_LABELS, 'Any severity');
export const CATEGORY_FILTER_OPTIONS = toOptions(CATEGORY_LABELS, 'Any category');
export const SOURCE_FILTER_OPTIONS = toOptions(SOURCE_LABELS, 'Any source');

/** Form controls, unlike filters, must not offer a blank option. */
export const SEVERITY_OPTIONS: SelectOption[] = Object.entries(SEVERITY_LABELS).map(
  ([value, label]) => ({ value, label })
);
export const CATEGORY_OPTIONS: SelectOption[] = Object.entries(CATEGORY_LABELS).map(
  ([value, label]) => ({ value, label })
);
