import type { SelectOption, StatusPillTone } from '@shared-ui';
import type { components } from '@api-client';

type Category = components['schemas']['CategoryEnum'];
type Status = components['schemas']['IncidentStatusEnum'];

/**
 * Passenger-facing wording for the two incident enums this app can see.
 *
 * A separate module from `client-admin-app`'s own `incident-labels.ts`
 * rather than something shared, for two reasons that both matter:
 *
 * 1. **The sets differ.** `PassengerIncidentSerializer` carries no
 *    `severity` and no `source`, so half of the operator module has
 *    nothing to label here. A shared module would export names this app
 *    must never render.
 * 2. **The wording differs on purpose.** An operator triaging a queue
 *    reads "Investigating"; the person waiting on an answer reads
 *    "Being investigated". "Open" is operator vocabulary for "we have
 *    it and nobody has looked yet", which to a passenger reads as
 *    "nothing has happened" — so it is "Received" here.
 *
 * Per-app label modules are this repo's established shape for exactly
 * this (`shared/trip-class.ts` is the same thing for `TripClassEnum`).
 *
 * Every pill built from these renders its **label as text**. Tone is
 * never the only indicator of status.
 */

const CATEGORY_LABEL: Record<Category, string> = {
  hardware: 'Card reader or ticket machine',
  vehicle: 'The vehicle',
  safety: 'Safety',
  service: 'Service or staff',
  gps: 'Location tracking',
  announcement: 'Stop announcement',
  other: 'Something else',
};

const STATUS_LABEL: Record<Status, string> = {
  open: 'Received',
  acknowledged: 'Acknowledged',
  investigating: 'Being investigated',
  resolved: 'Resolved',
  closed: 'Closed',
};

/**
 * Deliberately **not** the operator tones. `client-admin-app` renders
 * `open` as `negative`, which is right in a triage queue — an
 * unattended report is a problem someone has to fix. On this screen the
 * same row means "we have your report", and painting that red tells the
 * person who filed it that something went wrong with the filing.
 *
 * The passenger scale is therefore: nothing owed yet (neutral), being
 * worked on (warning), done (positive).
 */
const STATUS_TONE: Record<Status, StatusPillTone> = {
  open: 'neutral',
  acknowledged: 'warning',
  investigating: 'warning',
  resolved: 'positive',
  closed: 'neutral',
};

/**
 * Falls back to the raw value rather than rendering blank, so a
 * category the backend adds before this app catches up is still
 * readable rather than an empty cell.
 */
export function categoryLabel(value: string): string {
  return CATEGORY_LABEL[value as Category] ?? value;
}

export function statusLabel(value: string): string {
  return STATUS_LABEL[value as Status] ?? value;
}

export function statusTone(value: string): StatusPillTone {
  return STATUS_TONE[value as Status] ?? 'neutral';
}

/**
 * The report form's category picker.
 *
 * Leads with a blank prompt, so the control opens on a question rather
 * than on an answer the passenger did not give — `hardware` happens to
 * be first in the enum, and a select that silently pre-answers is how a
 * form submits something nobody chose.
 */
export const CATEGORY_OPTIONS: SelectOption[] = [
  // "Choose one", not "What went wrong?". The control's own label is
  // already "What went wrong", and a prompt that repeats it reads as a
  // stutter to anyone and is read out twice by a screen reader.
  { value: '', label: 'Choose one' },
  ...(Object.keys(CATEGORY_LABEL) as Category[]).map((value) => ({
    value,
    label: CATEGORY_LABEL[value],
  })),
];
