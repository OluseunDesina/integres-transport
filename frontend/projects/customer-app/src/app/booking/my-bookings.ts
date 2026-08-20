import { Dialog } from '@angular/cdk/dialog';
import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  TemplateRef,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import {
  Alert,
  Button,
  CONFIRM_DIALOG_TITLE_ID,
  ConfirmDialog,
  EmptyState,
  Paginator,
  StatusPill,
  Table,
} from '@shared-ui';
import type { ConfirmDialogData, ConfirmDialogResult, StatusPillTone } from '@shared-ui';

import { BookingStore, type Booking } from '../shared/data/store/booking.store';
import { formatMoney } from '../shared/money';

type BookingStatus = Booking['status'];

// Keyed on the closed status union rather than `string`, so a status
// added to the API is a compile error here instead of a booking that
// renders an untranslated `pending_payment` in the UI.
const STATUS_TONE: Record<BookingStatus, StatusPillTone> = {
  pending_payment: 'warning',
  paid: 'positive',
  cancelled: 'negative',
  expired: 'neutral',
};

const STATUS_LABEL: Record<BookingStatus, string> = {
  pending_payment: 'Pending payment',
  paid: 'Paid',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

// The backend's only legal cancel transition is from pending_payment
// (`BookingCancelSerializer.validate()`). Mirrored here so the action
// simply isn't rendered on rows it would 400 on, rather than offering a
// dead-end click — the same posture trip-list takes with its own status
// transitions.
const CANCELLABLE_STATUS = 'pending_payment';

// POST /payments/ only accepts a booking still in pending_payment
// (`BookingNotPayable` otherwise) — same "don't render a dead-end
// click" posture as CANCELLABLE_STATUS above.
const PAYABLE_STATUS = 'pending_payment';

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
 * The passenger's own bookings —
 * docs/specs/4-fares-seating-booking-frontend.md §4.3.
 *
 * Each row reads `trip.route.name` / `trip.scheduled_departure_at` from
 * the nested `trip` object added in this addendum's slice 1; a bare FK
 * id could not render a recognisable journey, which is the whole reason
 * that nesting exists.
 *
 * "Pay now" (Phase 5 frontend, Slice A) initiates a real Paystack
 * checkout for a `pending_payment` row and redirects the browser to
 * `authorization_url`. Deliberately scoped no further than that: no
 * dedicated wallet/payment-history screen, and `booking-confirm.ts`'s
 * post-create navigation is untouched — a passenger lands here first
 * either way and pays from this list, same as they already cancel from
 * it.
 */
@Component({
  selector: 'app-my-bookings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, Alert, Button, EmptyState, Paginator, StatusPill, Table],
  templateUrl: './my-bookings.html',
})
export class MyBookings implements OnInit {
  protected readonly store = inject(BookingStore);
  private readonly dialog = inject(Dialog);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);

  // One wallet-balance fetch per distinct Business among the current
  // page's pending_payment bookings, not one per row — a passenger's
  // pending bookings are usually all with the same operator.
  protected readonly walletBalances = signal<ReadonlyMap<string, string>>(new Map());
  protected readonly payingFromWalletBookingIds = signal<ReadonlySet<string>>(new Set());

  @ViewChild('cancelBody') private readonly cancelBody!: TemplateRef<unknown>;

  protected readonly statusTone = STATUS_TONE;
  protected readonly statusLabel = STATUS_LABEL;

  // A booking, not the whole screen visit, is the right idempotency
  // retry scope here — unlike booking-confirm's single-form key, a
  // passenger could plausibly attempt payment for two different
  // pending bookings in one visit to this list.
  private readonly paymentIdempotencyKeys = new Map<string, string>();

  protected readonly payingBookingIds = signal<ReadonlySet<string>>(new Set());
  protected readonly paymentError = signal<string | null>(null);

  protected readonly cancelReason = signal('');
  // Cancellation reason is optional server-side (`BookingCancel.reason`
  // defaults to blank), so nothing gates the confirm button here —
  // unlike the KYC reject and trip cancel dialogs, which do require one.
  protected readonly confirmDisabled = computed(() => false);
  protected readonly danger = computed(() => true);
  protected readonly confirmLabel = computed(() => 'Cancel booking');

  async ngOnInit(): Promise<void> {
    await this.store.getAll();
    await this.loadWalletBalances();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  private async loadWalletBalances(): Promise<void> {
    const businessIds = new Set(
      this.store
        .items()
        .filter((booking) => booking.status === PAYABLE_STATUS)
        .map((booking) => booking.business)
    );
    const entries = await Promise.all(
      Array.from(businessIds, async (businessId) => {
        const { data } = await this.api.GET('/api/v1/wallet/mine/', {
          params: { query: { business: businessId } },
          headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
        });
        return [businessId, data?.balance ?? '0.00'] as const;
      })
    );
    this.walletBalances.set(new Map(entries));
  }

  protected canCancel(booking: Booking): boolean {
    return booking.status === CANCELLABLE_STATUS;
  }

  protected canPayFromWallet(booking: Booking): boolean {
    if (booking.status !== PAYABLE_STATUS) {
      return false;
    }
    const balance = this.walletBalances().get(booking.business);
    // Display-only gate, not a source of truth — the backend
    // independently re-checks the exact Decimal balance under a row
    // lock at payment time (`InsufficientWalletBalance`), so a Number()
    // comparison here only decides whether the button renders, never
    // whether money actually moves.
    return balance !== undefined && Number(balance) >= Number(booking.total_amount);
  }

  protected canPay(booking: Booking): boolean {
    return booking.status === PAYABLE_STATUS;
  }

  protected canViewTickets(booking: Booking): boolean {
    return booking.status === 'paid';
  }

  protected async viewTickets(booking: Booking): Promise<void> {
    await this.router.navigate(['/my-bookings', booking.id, 'tickets']);
  }

  protected seatNumbers(booking: Booking): string {
    return booking.seats.map((seat) => seat.seat).join(', ') || '—';
  }

  protected totalLabel(booking: Booking): string {
    return formatMoney(booking.total_amount, booking.currency);
  }

  protected setCancelReason(value: string): void {
    this.cancelReason.set(value);
  }

  protected async goToSearch(): Promise<void> {
    await this.router.navigate(['/search']);
  }

  protected cancel(booking: Booking): void {
    this.cancelReason.set('');

    const ref = this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `Cancel booking — ${booking.trip.route.name}`,
        bodyTemplate: this.cancelBody,
        confirmLabel: this.confirmLabel,
        danger: this.danger,
        confirmDisabled: this.confirmDisabled,
        onConfirm: () => this.submitCancellation(booking.id),
      },
    });

    // Deferred one tick — see kyc-queue.ts's identical reasoning:
    // refetching in the same synchronous tick as the dialog's own
    // close/focus-restoration sequence races it and drops focus.
    ref.closed.subscribe(() => {
      setTimeout(() => void this.store.getAll());
    });
  }

  protected async payNow(booking: Booking): Promise<void> {
    if (this.payingBookingIds().has(booking.id)) {
      return;
    }
    this.paymentError.set(null);
    this.payingBookingIds.update((ids) => new Set(ids).add(booking.id));

    const { data, error } = await this.api.POST('/api/v1/payments/', {
      // Idempotency-Key is a declared header parameter on this
      // operation, same as booking creation — kept once-per-booking
      // (idempotencyKeyFor above) so a retry after a timeout returns
      // the original PaymentIntent instead of a second one.
      params: { header: { 'Idempotency-Key': this.idempotencyKeyFor(booking.id) } },
      body: { booking_id: booking.id },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    this.payingBookingIds.update((ids) => {
      const next = new Set(ids);
      next.delete(booking.id);
      return next;
    });

    if (data?.authorization_url) {
      this.redirectToPaystack(data.authorization_url);
      return;
    }
    this.paymentError.set(extractFirstErrorMessage(error, 'Could not start payment. Try again.'));
  }

  protected async payFromWallet(booking: Booking): Promise<void> {
    if (this.payingFromWalletBookingIds().has(booking.id)) {
      return;
    }
    this.paymentError.set(null);
    this.payingFromWalletBookingIds.update((ids) => new Set(ids).add(booking.id));

    // No Idempotency-Key: unlike payNow()'s Paystack round-trip, this
    // is synchronous and the backend's own row-lock on the booking
    // (`pay_booking_from_wallet`) already makes a double-click safe —
    // a retry just sees the booking already paid and fails cleanly.
    const { data, error } = await this.api.POST('/api/v1/bookings/{id}/pay-from-wallet/', {
      params: { path: { id: booking.id } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    this.payingFromWalletBookingIds.update((ids) => {
      const next = new Set(ids);
      next.delete(booking.id);
      return next;
    });

    if (data) {
      await this.store.getAll();
      return;
    }
    this.paymentError.set(
      extractFirstErrorMessage(error, 'Could not pay from your wallet. Try again.')
    );
  }

  private idempotencyKeyFor(bookingId: string): string {
    let key = this.paymentIdempotencyKeys.get(bookingId);
    if (!key) {
      key = crypto.randomUUID();
      this.paymentIdempotencyKeys.set(bookingId, key);
    }
    return key;
  }

  // Isolated for testability — spied on in specs instead of letting
  // jsdom actually navigate. No existing precedent for an external
  // redirect anywhere in this workspace; this is the seam.
  protected redirectToPaystack(url: string): void {
    window.location.href = url;
  }

  private async submitCancellation(bookingId: string): Promise<ConfirmDialogResult> {
    const { error } = await this.api.POST('/api/v1/bookings/{id}/cancel/', {
      params: { path: { id: bookingId } },
      body: { reason: this.cancelReason() },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    return error
      ? {
          ok: false,
          error: extractFirstErrorMessage(error, 'Could not cancel this booking. Try again.'),
        }
      : { ok: true };
  }
}
