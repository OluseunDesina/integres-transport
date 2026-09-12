import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { Alert, Button, EmptyState, PageHeader, Skeleton, StatusPill } from '@shared-ui';
import type { StatusPillTone } from '@shared-ui';
import { toDataURL } from 'qrcode';

import { tripClassLabel } from '../shared/trip-class';

export type Ticket = components['schemas']['Ticket'];

const STATUS_TONE: Record<Ticket['status'], StatusPillTone> = {
  issued: 'warning',
  boarded: 'positive',
  expired: 'neutral',
  revoked: 'negative',
};

const STATUS_LABEL: Record<Ticket['status'], string> = {
  issued: 'Issued',
  boarded: 'Boarded',
  expired: 'Expired',
  revoked: 'Revoked',
};

function extractFirstErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
    for (const value of Object.values(error as Record<string, unknown>)) {
      if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0];
      }
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  return fallback;
}

/**
 * A paid Booking's Tickets — docs/specs/6-ticketing.md's Frontend Slice
 * A. One QR per seat (`GET /bookings/{id}/tickets/` returns one Ticket
 * per `SeatReservation`, per the spec's own cardinality correction), so
 * this renders a list, not a single QR — normally one item, N for a
 * group booking.
 *
 * `signed_payload` is rendered directly as the QR's content, the same
 * way `my-credentials.ts` already renders a raw Tap & Go token — the
 * validator side decodes/verifies it, this screen never inspects it.
 */
@Component({
  selector: 'app-booking-tickets',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, Alert, Button, EmptyState, PageHeader, Skeleton, StatusPill],
  templateUrl: './booking-tickets.html',
})
export class BookingTickets implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly tickets = signal<Ticket[]>([]);
  protected readonly qrDataUrls = signal<Record<string, string>>({});

  protected readonly statusTone = STATUS_TONE;
  protected readonly statusLabel = STATUS_LABEL;

  async ngOnInit(): Promise<void> {
    const bookingId = this.route.snapshot.paramMap.get('id') ?? '';
    const { data, error } = await this.api.GET('/api/v1/bookings/{booking_id}/tickets/', {
      params: { path: { booking_id: bookingId } },
    });

    this.loading.set(false);

    if (!data) {
      this.error.set(extractFirstErrorMessage(error, 'Could not load tickets for this booking.'));
      return;
    }

    this.tickets.set(data.results);
    const entries = await Promise.all(
      data.results.map(
        async (ticket) => [ticket.id, await this.generateQrDataUrl(ticket.signed_payload)] as const
      )
    );
    this.qrDataUrls.set(Object.fromEntries(entries));
  }

  /** The service class this ticket is for
   * (docs/specs/15-trip-classes.md slice 3). Comes from the API rather
   * than from router state, because this screen is deep-linkable by
   * design — spec 6 made it a routed param precisely so it survives a
   * refresh, which router state does not. */
  protected serviceClass(ticket: Ticket): string {
    return tripClassLabel(ticket.trip_class);
  }

  protected async backToBookings(): Promise<void> {
    await this.router.navigate(['/my-bookings']);
  }

  // Isolated for testability, same convention as my-credentials.ts's
  // generateQrDataUrl — specs spy on this instead of exercising the
  // real encoder.
  //
  // 340, not 220: Senior Mode (spec 21 slice 3) renders this image at
  // `--ui-qr-size` (340px there, 220px otherwise) via CSS, not a second
  // TypeScript branch — generating the PNG at the larger fixed
  // resolution up front means the default 220px display downscales a
  // sharp source instead of the 220px mode ever upscaling a blurry one.
  protected async generateQrDataUrl(payload: string): Promise<string> {
    return toDataURL(payload, { width: 340, margin: 1 });
  }
}
