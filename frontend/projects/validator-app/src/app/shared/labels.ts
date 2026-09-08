import type { components } from '@api-client';

type TripStatus = components['schemas']['Trip']['status'];
type JourneyStatus = components['schemas']['FareJourney']['status'];

/**
 * The words this app says out loud, in place of the API's enum values.
 *
 * Both screens rendered raw enums until spec 14 slice 6b — a trip line
 * reading "scheduled", a success alert reading "boarded" and "Recorded.
 * Journey open". Same family as slice 4's F5, which replaced
 * `proof_of_address` with "Proof of address" on the KYC screen.
 *
 * The two `Record`s are keyed on closed unions, so a status added to the
 * API is a compile error here rather than an untranslated word on a
 * conductor's screen — the shape `my-bookings`' own status maps use.
 */
export const TRIP_STATUS_LABEL: Record<TripStatus, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** "Journey open" told a conductor nothing actionable. What they need to
 * know is whether the fare is still running or has been settled. */
export const JOURNEY_STATUS_LABEL: Record<JourneyStatus, string> = {
  open: 'in progress',
  closed: 'complete',
  needs_review: 'flagged for review',
};

/**
 * A ticket status, which **cannot** get the exhaustive treatment above:
 * `TicketValidationResult.status` is typed `string` in the generated
 * schema, not an enum, so there is no union to key on and no compile
 * error to rely on.
 *
 * Hence the explicit fallback — an unrecognised status still reads as a
 * word rather than as `some_new_state`, which is the outcome that
 * matters on a device held in front of a passenger.
 */
const TICKET_STATUS_LABEL: Record<string, string> = {
  issued: 'Issued',
  boarded: 'Boarded',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

export function ticketStatusLabel(status: string): string {
  return TICKET_STATUS_LABEL[status] ?? humanise(status);
}

function humanise(value: string): string {
  const words = value.replaceAll('_', ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/** A service date as a person reads it, not as the API sends it. The
 * `T00:00:00` is load-bearing: `new Date("2026-09-02")` parses as UTC
 * midnight and renders as the previous day west of Greenwich. */
export function formatServiceDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}
