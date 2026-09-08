import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  Alert,
  EmptyState,
  ExportButton,
  PageHeader,
  Paginator,
  Skeleton,
  Stat,
  StatusPill,
  Table,
  Toggle,
  formatMoney,
  summaryLine,
  type StatusPillTone,
} from '@shared-ui';

import { ExportStore } from '../../shared/data/store/export.store';
import {
  ManifestStore,
  asJourneyRow,
  asPrepaidRow,
  type ManifestJourneyRow,
  type ManifestPrepaidRow,
  type ManifestRow,
} from '../../shared/data/store/manifest.store';
import { tripClassLabel } from '../../shared/trip-class';

/** Rendered wherever a value can legitimately be unknown. Never a zero:
 * "no vehicle assigned" and "nobody aboard" are different facts, and a
 * `0` beside Capacity says the second while meaning the first. */
const NOT_RECORDED = 'Not recorded';

const TICKET_STATUS_TONE: Record<string, StatusPillTone> = {
  issued: 'neutral',
  boarded: 'positive',
  expired: 'warning',
  revoked: 'negative',
};

const BOOKING_STATUS_TONE: Record<string, StatusPillTone> = {
  pending_payment: 'warning',
  paid: 'positive',
  completed: 'positive',
  cancelled: 'negative',
  expired: 'neutral',
};

const JOURNEY_STATUS_LABEL: Record<string, string> = {
  open: 'Still aboard',
  closed: 'Alighted',
  needs_review: 'Needs review',
};

const JOURNEY_STATUS_TONE: Record<string, StatusPillTone> = {
  open: 'warning',
  closed: 'positive',
  needs_review: 'negative',
};

function humanise(value: string): string {
  return value ? value.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase()) : value;
}

/**
 * Who is aboard one trip — docs/specs/18-manifest-and-staff-booking.md
 * slice 1.
 *
 * ## `kind` decides what the table is
 *
 * A prepaid trip lists **tickets**: reference, passenger, seat, and
 * whether they have boarded. A pay-as-you-go trip has no bookings and
 * no tickets at all, so it lists **journeys**: who tapped on, where,
 * and whether they are still aboard. Two column sets in one component
 * rather than two screens, because they answer the same question and an
 * operator should not have to know how a route collects fares before
 * choosing a menu item.
 *
 * ## Nulls are the design
 *
 * `capacity` is `null` with no vehicle assigned, and an open journey has
 * neither an alight stop nor a fare because the passenger has not
 * finished travelling. All three render as words, never as `0` or a
 * blank cell.
 *
 * Gated on `booking.view`, deliberately not `analytics.view` like
 * `trip-performance` beside it: the person who most needs this is the
 * one standing at the door, and the Staff preset holds the first and
 * not the second.
 */
@Component({
  selector: 'app-trip-manifest',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    RouterLink,
    Alert,
    EmptyState,
    ExportButton,
    PageHeader,
    Paginator,
    Skeleton,
    Stat,
    StatusPill,
    Table,
    Toggle,
  ],
  templateUrl: './trip-manifest.html',
})
export class TripManifest implements OnInit {
  protected readonly store = inject(ManifestStore);
  protected readonly exports = inject(ExportStore);
  private readonly route = inject(ActivatedRoute);

  protected readonly notRecorded = NOT_RECORDED;
  protected readonly tripClassLabel = tripClassLabel;
  protected readonly humanise = humanise;

  private readonly tripId = this.route.snapshot.paramMap.get('id') ?? '';

  protected readonly trip = computed(() => this.store.data()?.trip ?? null);
  protected readonly totals = computed(() => this.store.data()?.totals ?? null);

  /** Read off the envelope, never inferred from which keys a row
   * happens to carry. */
  protected readonly isJourneyKind = computed(
    () => this.store.data()?.kind === 'pay_as_you_go'
  );

  protected readonly prepaidRows = computed<ManifestPrepaidRow[]>(() =>
    this.isJourneyKind() ? [] : this.store.rows().map(asPrepaidRow)
  );

  protected readonly journeyRows = computed<ManifestJourneyRow[]>(() =>
    this.isJourneyKind() ? this.store.rows().map(asJourneyRow) : []
  );

  ngOnInit(): void {
    void this.store.load(this.tripId);
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onIncludeCancelled(checked: boolean): void {
    void this.store.setIncludeCancelled(checked);
  }

  protected async download(): Promise<void> {
    await this.exports.download('manifest', { trip: this.tripId });
  }

  protected capacityLabel(): string {
    const capacity = this.totals()?.capacity;
    // `null` means no vehicle is assigned. `0` would say the bus is
    // full, which is the opposite of what is true.
    return capacity === null || capacity === undefined ? 'No vehicle assigned' : String(capacity);
  }

  /** `null` means no ticket has been issued yet — the booking holds a
   * seat but has not been paid for. With no cash account in the ledger
   * (ADR-0006) that is the ordinary state of a counter booking, not an
   * anomaly, so it is named rather than left blank. */
  protected ticketStatusLabel(value: string | null): string {
    return value ? humanise(value) : 'Not issued';
  }

  protected ticketStatusTone(value: string | null): StatusPillTone {
    return value ? (TICKET_STATUS_TONE[value] ?? 'neutral') : 'warning';
  }

  protected bookingStatusTone(value: string): StatusPillTone {
    return BOOKING_STATUS_TONE[value] ?? 'neutral';
  }

  protected journeyStatusLabel(value: string): string {
    return JOURNEY_STATUS_LABEL[value] ?? humanise(value);
  }

  protected journeyStatusTone(value: string): StatusPillTone {
    return JOURNEY_STATUS_TONE[value] ?? 'neutral';
  }

  protected fareLabel(row: ManifestRow): string {
    const fare = (row as { fare?: string | null }).fare;
    const currency = (row as { currency?: string }).currency ?? '';
    // A fare of `null` on an open journey is genuinely not yet known —
    // the passenger is still travelling — and "0.00" would be a claim
    // they rode for free.
    return fare ? formatMoney(fare, currency) : NOT_RECORDED;
  }

  /** The columns hidden below `md`, re-flowed under the passenger. */
  protected prepaidSummary(row: ManifestPrepaidRow): string {
    return summaryLine([row.booking_reference, this.fareLabel(row), humanise(row.booking_status)]);
  }

  protected journeySummary(row: ManifestJourneyRow): string {
    return summaryLine([
      `${row.board_stop} → ${row.alight_stop ?? NOT_RECORDED}`,
      this.fareLabel(row),
    ]);
  }
}
