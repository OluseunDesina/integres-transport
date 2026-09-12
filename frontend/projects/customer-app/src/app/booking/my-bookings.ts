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
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import {
  ActionMenu,
  Alert,
  Button,
  CONFIRM_DIALOG_TITLE_ID,
  ConfirmDialog,
  Countdown,
  EmptyState,
  PageHeader,
  Paginator,
  StatusPill,
  Table,
  Textarea,
  Toggle,
  summaryLine,
} from '@shared-ui';
import type {
  ActionMenuItem,
  ConfirmDialogData,
  ConfirmDialogResult,
  StatusPillTone,
} from '@shared-ui';

import { BookingStore, type Booking } from '../shared/data/store/booking.store';
import { formatMoney } from '../shared/money';
import { tripClassLabel } from '../shared/trip-class';

type BookingStatus = Booking['status'];

// Keyed on the closed status union rather than `string`, so a status
// added to the API is a compile error here instead of a booking that
// renders an untranslated `pending_payment` in the UI.
const STATUS_TONE: Record<BookingStatus, StatusPillTone> = {
  pending_payment: 'warning',
  paid: 'positive',
  completed: 'positive',
  cancelled: 'negative',
  expired: 'neutral',
};

const STATUS_LABEL: Record<BookingStatus, string> = {
  pending_payment: 'Pending payment',
  paid: 'Paid',
  completed: 'Completed',
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
 * `authorization_url`. docs/specs/7-passenger-wallet.md's later
 * Implementation note (the blended-payment revisit) folded the
 * previously-separate "Pay from wallet" button into this same action:
 * a checkbox applies the wallet balance first, and `payNow()` handles
 * both possible outcomes — a `succeeded` response with no
 * `authorization_url` (wallet covered it all, nothing to redirect to)
 * or an `authorization_url` for whatever remainder (if any) Paystack
 * still needs to collect.
 */
@Component({
  selector: 'app-my-bookings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    ActionMenu,
    Alert,
    Button,
    Countdown,
    EmptyState,
    PageHeader,
    Paginator,
    StatusPill,
    Table,
    Textarea,
    Toggle,
  ],
  templateUrl: './my-bookings.html',
})
export class MyBookings implements OnInit {
  protected readonly store = inject(BookingStore);
  private readonly dialog = inject(Dialog);
  private readonly api = inject(API_CLIENT);
  private readonly router = inject(Router);

  // One wallet-balance fetch per distinct Business among the current
  // page's pending_payment bookings, not one per row — a passenger's
  // pending bookings are usually all with the same operator.
  protected readonly walletBalances = signal<ReadonlyMap<string, string>>(new Map());
  // Per-row "use my wallet balance" checkbox state — a passenger could
  // plausibly want it for one pending booking and not another.
  protected readonly useWalletBalanceIds = signal<ReadonlySet<string>>(new Set());

  @ViewChild('cancelBody') private readonly cancelBody!: TemplateRef<unknown>;
  @ViewChild('payBody') private readonly payBody!: TemplateRef<unknown>;

  protected readonly statusTone = STATUS_TONE;
  protected readonly statusLabel = STATUS_LABEL;

  // A booking, not the whole screen visit, is the right idempotency
  // retry scope here — unlike booking-confirm's single-form key, a
  // passenger could plausibly attempt payment for two different
  // pending bookings in one visit to this list.
  private readonly paymentIdempotencyKeys = new Map<string, string>();

  protected readonly payingBookingIds = signal<ReadonlySet<string>>(new Set());
  protected readonly paymentError = signal<string | null>(null);
  /** Set only on the wallet-covers-everything path, which completes
   * without leaving the app — nothing else tells the passenger it
   * worked, since there is no Paystack redirect to come back from. */
  protected readonly paymentSuccess = signal<string | null>(null);

  /** The booking the pay dialog is open for. The dialog body is one
   * template rendered inside `ui-confirm-dialog`, so it needs a single
   * subject rather than a per-row binding. */
  protected readonly payingBooking = signal<Booking | null>(null);

  protected readonly cancelReason = signal('');
  // Cancellation reason is optional server-side (`BookingCancel.reason`
  // defaults to blank), so nothing gates the confirm button here —
  // unlike the KYC reject and trip cancel dialogs, which do require one.
  protected readonly confirmDisabled = computed(() => false);
  protected readonly danger = computed(() => true);
  protected readonly confirmLabel = computed(() => 'Cancel booking');

  /** Never `danger`: paying is the thing the passenger came to do. The
   * dialog exists to show them what they are about to be charged, not
   * to warn them off it. */
  protected readonly payDanger = computed(() => false);

  /**
   * Names the outcome, so the button says what pressing it does.
   *
   * A wallet that covers the whole amount completes in place; anything
   * else hands the passenger to Paystack, and being sent to a bank page
   * unannounced is the kind of surprise that gets a payment abandoned.
   */
  protected readonly payConfirmLabel = computed(() => {
    const booking = this.payingBooking();
    if (!booking) {
      return 'Pay';
    }
    return this.fullyCoveredByWallet(booking) ? 'Pay from wallet' : 'Continue to Paystack';
  });

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
        });
        return [businessId, data?.balance ?? '0.00'] as const;
      })
    );
    this.walletBalances.set(new Map(entries));
  }

  protected canCancel(booking: Booking): boolean {
    return booking.status === CANCELLABLE_STATUS;
  }

  protected canPay(booking: Booking): boolean {
    return booking.status === PAYABLE_STATUS;
  }

  // The checkbox only makes sense when there's an actual balance to
  // apply — nothing to offer on a zero/unknown balance.
  protected canUseWalletBalance(booking: Booking): boolean {
    if (booking.status !== PAYABLE_STATUS) {
      return false;
    }
    const balance = this.walletBalances().get(booking.business);
    return balance !== undefined && Number(balance) > 0;
  }

  protected isUsingWalletBalance(booking: Booking): boolean {
    return this.useWalletBalanceIds().has(booking.id);
  }

  protected toggleUseWalletBalance(booking: Booking, checked: boolean): void {
    this.useWalletBalanceIds.update((ids) => {
      const next = new Set(ids);
      if (checked) {
        next.add(booking.id);
      } else {
        next.delete(booking.id);
      }
      return next;
    });
  }

  // Display-only preview of the split, computed from the same balance
  // `canUseWalletBalance` already reads — never a source of truth. The
  // backend independently computes and enforces the actual split under
  // a row lock at payment time; this only decides what text renders
  // before the passenger clicks "Pay now", same "display-only" posture
  // this file already established for the old canPayFromWallet gate.
  protected walletBreakdown(
    booking: Booking
  ): { balance: string; walletPortion: string; remainder: string; fullyCovered: boolean } | null {
    const balance = this.walletBalances().get(booking.business);
    if (balance === undefined) {
      return null;
    }
    const total = Number(booking.total_amount);
    const walletPortion = Math.min(Number(balance), total);
    const remainder = Math.max(0, total - walletPortion);
    return {
      // The whole balance, distinct from `walletPortion` — that one is
      // capped at this booking's total, and the two are only the same
      // number when the wallet cannot cover the fare.
      balance: formatMoney(balance, booking.currency),
      walletPortion: formatMoney(walletPortion.toFixed(2), booking.currency),
      remainder: formatMoney(remainder.toFixed(2), booking.currency),
      fullyCovered: remainder === 0,
    };
  }

  protected canViewTickets(booking: Booking): boolean {
    return booking.status === 'paid';
  }

  /** `paid` (in progress or yet to depart) or `completed` — the trip
   * spec 20's `GET /trips/{id}/live/` can meaningfully answer "where is
   * it"/"where did it end up" for. A booking that never paid, or was
   * cancelled or expired, never had a real departure to track. */
  protected canTrack(booking: Booking): boolean {
    return booking.status === 'paid' || booking.status === 'completed';
  }

  /** `ui-countdown` reaching zero on a row is not the same fact as that
   * row's hold actually being gone — the sweep task runs once a
   * minute. There is no single-booking re-fetch for a passenger
   * (`docs/specs/21-passenger-experience.md` slice 2, and
   * `BookingStore`'s own docstring: `/bookings/mine/` is the only
   * endpoint a passenger can read their own bookings through), so this
   * reloads the whole current page rather than one row — the same
   * `getAll()` `onPageChange` already calls, and correct here too: a
   * hold expiring is exactly the moment this row's own status might
   * have changed to `expired` server-side.
   */
  protected onHoldExpired(): void {
    void this.store.getAll();
  }

  /**
   * The row's secondary actions.
   *
   * Paying stays a real button outside the menu — it is the one thing a
   * passenger opens this screen to do, and burying it behind a kebab
   * would be a worse screen, not a tidier one. What moves in is
   * everything else, so the cell holds at most two controls at 390px
   * instead of the four it did before.
   */
  protected menuItemsFor(booking: Booking): ActionMenuItem[] {
    const items: ActionMenuItem[] = [];
    if (this.canViewTickets(booking)) {
      items.push({ id: 'tickets', label: 'View tickets', icon: 'document-check' });
    }
    if (this.canTrack(booking)) {
      items.push({ id: 'track', label: 'Track this trip', icon: 'map-pin' });
    }
    if (this.canCancel(booking)) {
      items.push({ id: 'cancel', label: 'Cancel booking', icon: 'x-mark', danger: true });
    }
    // Offered on every booking whatever its status. A trip can go wrong
    // for someone who never paid (a reader that would not take the
    // card is exactly that story) and for someone whose trip is long
    // over, so gating this on status would hide it from two of the
    // people most likely to need it.
    items.push({ id: 'report', label: 'Report a problem', icon: 'exclamation-triangle' });
    return items;
  }

  protected async onAction(booking: Booking, id: string): Promise<void> {
    if (id === 'tickets') {
      await this.viewTickets(booking);
      return;
    }
    if (id === 'track') {
      await this.router.navigate(['/trips', booking.trip.id, 'track']);
      return;
    }
    if (id === 'report') {
      // The booking id, not the trip id: `report-issue` resolves the
      // Booking to get the operator and a human label for the trip as
      // well, and a trip id alone would name none of that.
      await this.router.navigate(['/report-issue'], { queryParams: { booking: booking.id } });
      return;
    }
    if (id === 'cancel') {
      this.cancel(booking);
    }
  }

  /** The hidden columns, re-flowed under the route name below `md`. */
  protected summaryFor(booking: Booking): string {
    return summaryLine([
      new Date(booking.trip.scheduled_departure_at).toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
      this.seatNumbers(booking),
      this.totalLabel(booking),
    ]);
  }

  /**
   * The class pill sits beside the route name rather than in a column
   * of its own or in the `md:hidden` sub-line.
   *
   * Not a column: this table is already at its 390px limit (spec 14's
   * iteration-15 recorded Route squeezed to ~60px), and a fifth
   * `md:table-cell` would push it back over. Not the sub-line either —
   * that whole span is `md:hidden`, so the class would vanish above
   * `md`, which is the opposite of what a re-flow is for.
   */
  protected serviceClass(booking: Booking): string {
    return tripClassLabel(booking.trip.trip_class);
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

  private fullyCoveredByWallet(booking: Booking): boolean {
    return (
      this.isUsingWalletBalance(booking) && (this.walletBreakdown(booking)?.fullyCovered ?? false)
    );
  }

  /** What applying the balance would actually do to this amount. */
  protected walletExplainer(booking: Booking): string {
    const breakdown = this.walletBreakdown(booking);
    if (!breakdown) {
      return 'Your balance will be applied first.';
    }
    if (!this.isUsingWalletBalance(booking)) {
      // The whole balance, not `walletPortion` — that one is capped at
      // this booking's total, so a passenger with more than the fare in
      // their wallet would be told they have exactly the fare.
      return `You have ${breakdown.balance} available with this operator.`;
    }
    return breakdown.fullyCovered
      ? 'Your balance covers this in full — no card payment needed.'
      : `${breakdown.walletPortion} from your balance, ${breakdown.remainder} on your card.`;
  }

  /** Where the confirm button leads. A passenger sent to a bank page
   * with no warning is a passenger who abandons the payment. */
  protected payOutcomeHint(booking: Booking): string {
    return this.fullyCoveredByWallet(booking)
      ? 'This completes here — you will not leave the app.'
      : 'You will be taken to Paystack to complete the payment.';
  }

  /**
   * Opens the pay confirmation.
   *
   * The old screen charged on one tap of "Pay now", with the wallet
   * option a bare checkbox loose in the table cell beside it. Money
   * moving is worth one deliberate step and one place to read the
   * amount, the split and where the passenger is about to be sent.
   */
  protected openPayDialog(booking: Booking): void {
    this.paymentError.set(null);
    this.paymentSuccess.set(null);
    this.payingBooking.set(booking);

    this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `Pay for ${booking.trip.route.name}`,
        bodyTemplate: this.payBody,
        confirmLabel: this.payConfirmLabel,
        danger: this.payDanger,
        confirmDisabled: this.confirmDisabled,
        onConfirm: () => this.payNow(booking),
      },
    });
  }

  /**
   * Charges the booking, and reports the outcome the way the dialog
   * needs it.
   *
   * Returns `ConfirmDialogResult` rather than void: a failure has to
   * keep the dialog open with the message in it, which is the whole
   * contract `ui-confirm-dialog` provides and what the cancel flow here
   * already uses.
   */
  protected async payNow(booking: Booking): Promise<ConfirmDialogResult> {
    if (this.payingBookingIds().has(booking.id)) {
      return { ok: true };
    }
    this.paymentError.set(null);
    this.payingBookingIds.update((ids) => new Set(ids).add(booking.id));

    const { data, error } = await this.api.POST('/api/v1/payments/', {
      // Idempotency-Key is a declared header parameter on this
      // operation, same as booking creation — kept once-per-booking
      // (idempotencyKeyFor above) so a retry after a timeout returns
      // the original PaymentIntent instead of a second one.
      params: { header: { 'Idempotency-Key': this.idempotencyKeyFor(booking.id) } },
      body: { booking_id: booking.id, use_wallet_balance: this.isUsingWalletBalance(booking) },
    });

    this.payingBookingIds.update((ids) => {
      const next = new Set(ids);
      next.delete(booking.id);
      return next;
    });

    if (data?.authorization_url) {
      this.redirectToPaystack(data.authorization_url);
      return { ok: true };
    }
    if (data?.status === 'succeeded') {
      // The wallet balance covered the full amount — no Paystack
      // round-trip happened, nothing to redirect to. Which is exactly
      // why this path needs to say so: there is no return journey from
      // a payment page to signal that anything happened.
      this.paymentSuccess.set(
        `Paid ${this.totalLabel(booking)} for ${booking.trip.route.name} from your wallet.`
      );
      await this.store.getAll();
      await this.loadWalletBalances();
      return { ok: true };
    }

    const message = extractFirstErrorMessage(error, 'Could not start payment. Try again.');
    // Both places: inside the dialog, which stays open, and on the page
    // behind it, so the message survives the passenger dismissing it.
    this.paymentError.set(message);
    return { ok: false, error: message };
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
    });

    return error
      ? {
          ok: false,
          error: extractFirstErrorMessage(error, 'Could not cancel this booking. Try again.'),
        }
      : { ok: true };
  }
}
