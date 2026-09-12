import { Dialog } from '@angular/cdk/dialog';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { expectColumnVisibilityParity } from '@shared-ui';
import type { ConfirmDialogData } from '@shared-ui';
import { Subject } from 'rxjs';

import { MyBookings } from './my-bookings';

interface WithRedirect {
  redirectToPaystack(url: string): void;
}

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'booking-1',
    business: 'biz-1',
    trip: {
      id: 'trip-1',
      route: { id: 'route-1', name: 'Ikeja → CMS' },
      scheduled_departure_at: '2026-09-01T06:30:00Z',
      service_date: '2026-09-01',
      trip_class: 'standard',
    },
    passenger: 'user-1',
    status: 'pending_payment',
    total_amount: '1500.00',
    currency: 'NGN',
    cancellation_reason: '',
    seats: [
      { id: 'res-1', seat: '1A', from_stop: 'Ikeja', to_stop: 'CMS', status: 'held', held_until: '' },
      { id: 'res-2', seat: '1B', from_stop: 'Ikeja', to_stop: 'CMS', status: 'held', held_until: '' },
    ],
    // A real hold by default, matching the seated status above —
    // docs/specs/21-passenger-experience.md slice 2. Tests for the
    // no-hold case (paid, open seating) override both to null.
    hold_expires_at: '2026-08-10T00:15:00Z',
    hold_expires_in_seconds: 900,
    created_at: '2026-08-10T00:00:00Z',
    ...overrides,
  };
}

describe('MyBookings', () => {
  let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy };
  let dialog: { open: jasmine.Spy };
  let closed: Subject<boolean>;
  let fixture: ComponentFixture<MyBookings>;
  let component: MyBookings;

  async function createComponent(): Promise<void> {
    fixture = TestBed.createComponent(MyBookings);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** The dialog owns the submit lifecycle, so a test drives the flow by
   * invoking the `onConfirm` the component handed it. */
  function lastDialogData(): ConfirmDialogData {
    return dialog.open.calls.mostRecent().args[1].data as ConfirmDialogData;
  }

  beforeEach(() => {
    apiClient = {
      GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 1, results: [makeBooking()] } }),
      POST: jasmine.createSpy('POST').and.resolveTo({ data: makeBooking({ status: 'cancelled' }) }),
    };
    closed = new Subject<boolean>();
    dialog = { open: jasmine.createSpy('open').and.returnValue({ closed }) };

    TestBed.configureTestingModule({
      imports: [MyBookings],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: apiClient },
        { provide: Dialog, useValue: dialog },
      ],
    });
  });

  it('loads the passengers own bookings on init', async () => {
    await createComponent();

    expect(apiClient.GET).toHaveBeenCalledWith('/api/v1/bookings/mine/', jasmine.anything());
    expect(component['store'].items().length).toBe(1);
  });

  it('renders the nested trip route and departure, not a bare id', async () => {
    await createComponent();

    const cells = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr td')
    ).map((td) => td.textContent?.trim());
    // The route cell also carries the responsive sub-line now, so it is
    // asserted by its parts rather than by exact equality.
    expect(cells[0]).toContain('Ikeja → CMS');
    expect(cells[1]).not.toBe('trip-1');
    expect(cells[2]).toBe('1A, 1B');
    expect(cells[3]).toBe('NGN 1500.00');
  });

  it('names the service class beside the route, at every width', async () => {
    // docs/specs/15-trip-classes.md slice 3. Beside the route name, not
    // in the md:hidden sub-line — that whole span disappears above `md`,
    // which would hide the class on exactly the widths that have room
    // for it.
    apiClient.GET.and.resolveTo({
      data: { count: 1, results: [makeBooking({ trip: { ...makeBooking().trip, trip_class: 'premium' } })] },
    });

    await createComponent();

    const routeCell = (fixture.nativeElement as HTMLElement).querySelector('tbody tr td');
    const pill = routeCell?.querySelector('ui-status-pill');
    expect(pill?.textContent).toContain('Premium');
    expect(pill?.closest('.md\\:hidden')).toBeNull();
  });

  it('shows an empty state before any booking exists', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await createComponent();

    expect((fixture.nativeElement as HTMLElement).querySelector('ui-empty-state')).toBeTruthy();
  });

  // Cancel moved into the row's action menu in spec 14 slice 5: the
  // cell held a bare checkbox, a breakdown paragraph and up to three
  // buttons, which squeezed the Route column at 390px.
  it('offers cancel in the action menu on a pending_payment booking', async () => {
    await createComponent();

    expect(component['canCancel'](makeBooking() as never)).toBeTrue();
    const items = component['menuItemsFor'](makeBooking() as never);
    expect(items.map((item) => item.id)).toContain('cancel');
    expect(items.find((item) => item.id === 'cancel')?.danger).toBeTrue();
  });

  // The backend only allows cancelling from pending_payment, so a
  // cancelled or expired row must not render an action that would 400.
  ['cancelled', 'expired'].forEach((status) => {
    it(`renders no cancel action on a ${status} booking`, async () => {
      apiClient.GET.and.resolveTo({
        data: { count: 1, results: [makeBooking({ status })] },
      });

      await createComponent();

      expect(component['canCancel'](makeBooking({ status }) as never)).toBeFalse();
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('tbody tr td:last-child ui-button')
      ).toBeNull();
    });
  });

  it('posts the cancellation with the reason typed into the dialog', async () => {
    await createComponent();

    component['cancel'](makeBooking() as never);
    component['setCancelReason']('Plans changed');
    const result = await lastDialogData().onConfirm();

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/bookings/{id}/cancel/',
      jasmine.objectContaining({
        params: { path: { id: 'booking-1' } },
        body: { reason: 'Plans changed' },
      })
    );
    expect(result).toEqual({ ok: true });
  });

  it('allows cancelling without a reason', async () => {
    await createComponent();

    component['cancel'](makeBooking() as never);

    expect(component['confirmDisabled']()).toBeFalse();
    await lastDialogData().onConfirm();
    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/bookings/{id}/cancel/',
      jasmine.objectContaining({ body: { reason: '' } })
    );
  });

  // A booking cancelled in another tab loses the race, and the server
  // reports it as a field error rather than a `detail` string — this is
  // the exact body observed from POST /bookings/{id}/cancel/.
  it('keeps the dialog open with the server message when cancelling fails', async () => {
    await createComponent();
    apiClient.POST.and.resolveTo({
      error: { status: ['Cannot cancel a booking in cancelled status.'] },
    });

    component['cancel'](makeBooking() as never);
    const result = await lastDialogData().onConfirm();

    expect(result).toEqual({
      ok: false,
      error: 'Cannot cancel a booking in cancelled status.',
    });
  });

  it('opens the dialog with aria wiring and a destructive confirm', async () => {
    await createComponent();

    component['cancel'](makeBooking() as never);

    const config = dialog.open.calls.mostRecent().args[1];
    expect(config.ariaModal).toBeTrue();
    expect(config.ariaLabelledBy).toBe('ui-confirm-dialog-title');
    expect(lastDialogData().danger()).toBeTrue();
    expect(lastDialogData().title).toContain('Ikeja → CMS');
  });

  it('refetches after the dialog closes, deferred a tick so focus restoration wins', async () => {
    await createComponent();
    apiClient.GET.calls.reset();

    component['cancel'](makeBooking() as never);
    closed.next(true);

    expect(apiClient.GET).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiClient.GET).toHaveBeenCalled();
  });

  // Pay stays a real button rather than moving into the menu: it is the
  // one thing a passenger opens this screen to do.
  it('offers pay as the row\'s primary action on a pending_payment booking', async () => {
    await createComponent();

    expect(component['canPay'](makeBooking() as never)).toBeTrue();
    const actions = (fixture.nativeElement as HTMLElement).querySelectorAll(
      'tbody tr td:last-child ui-button'
    );
    expect(actions[0]?.textContent?.trim()).toBe('Pay');
  });

  // POST /payments/ only accepts a pending_payment booking
  // (BookingNotPayable otherwise), so paid/cancelled/expired rows must
  // not render an action that would 409.
  ['paid', 'cancelled', 'expired'].forEach((status) => {
    it(`renders no pay action on a ${status} booking`, async () => {
      apiClient.GET.and.resolveTo({
        data: { count: 1, results: [makeBooking({ status })] },
      });

      await createComponent();

      expect(component['canPay'](makeBooking({ status }) as never)).toBeFalse();
    });
  });

  it('starts a payment and redirects to the returned authorization_url', async () => {
    await createComponent();
    apiClient.POST.and.resolveTo({
      data: { id: 'intent-1', status: 'pending', authorization_url: 'https://paystack.test/pay/x', reference: 'ref-1' },
    });
    const redirect = spyOn(component as unknown as WithRedirect, 'redirectToPaystack');

    await component['payNow'](makeBooking() as never);

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/payments/',
      jasmine.objectContaining({
        params: { header: { 'Idempotency-Key': jasmine.any(String) } },
        body: { booking_id: 'booking-1', use_wallet_balance: false },
      })
    );
    expect(redirect).toHaveBeenCalledWith('https://paystack.test/pay/x');
    expect(component['paymentError']()).toBeNull();
  });

  it('reuses the same Idempotency-Key across two payment attempts for the same booking', async () => {
    await createComponent();
    apiClient.POST.and.resolveTo({
      data: { id: 'intent-1', status: 'pending', authorization_url: 'https://paystack.test/pay/x', reference: 'ref-1' },
    });
    spyOn(component as unknown as WithRedirect, 'redirectToPaystack');

    await component['payNow'](makeBooking() as never);
    await component['payNow'](makeBooking() as never);

    const firstKey = apiClient.POST.calls.first().args[1].params.header['Idempotency-Key'];
    const secondKey = apiClient.POST.calls.mostRecent().args[1].params.header['Idempotency-Key'];
    expect(firstKey).toBe(secondKey);
  });

  it('shows the server message when a payment cannot be started', async () => {
    await createComponent();
    apiClient.POST.and.resolveTo({
      error: { detail: 'This Business has no active Paystack account configured.' },
    });

    await component['payNow'](makeBooking() as never);
    fixture.detectChanges();

    expect(component['paymentError']()).toBe(
      'This Business has no active Paystack account configured.'
    );
    expect((fixture.nativeElement as HTMLElement).querySelector('ui-alert')?.textContent?.trim()).toBe(
      'This Business has no active Paystack account configured.'
    );
  });

  it('loads a wallet balance for each distinct Business among pending_payment bookings', async () => {
    apiClient.GET.and.callFake((path: string) => {
      if (path === '/api/v1/wallet/mine/') {
        return Promise.resolve({ data: { balance: '2000.00', currency: 'NGN', transactions: [] } });
      }
      return Promise.resolve({ data: { count: 1, results: [makeBooking()] } });
    });

    await createComponent();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/wallet/mine/',
      jasmine.objectContaining({ params: { query: { business: 'biz-1' } } })
    );
    expect(component['canUseWalletBalance'](makeBooking() as never)).toBeTrue();
  });

  it('does not offer the wallet-balance checkbox on a zero balance', async () => {
    apiClient.GET.and.callFake((path: string) => {
      if (path === '/api/v1/wallet/mine/') {
        return Promise.resolve({ data: { balance: '0.00', currency: 'NGN', transactions: [] } });
      }
      return Promise.resolve({ data: { count: 1, results: [makeBooking()] } });
    });

    await createComponent();

    expect(component['canUseWalletBalance'](makeBooking() as never)).toBeFalse();
    // Nothing loose in the cell either — the wallet control moved into
    // the pay dialog in slice 5, and it was a bare <input type=checkbox>
    // in a read table before that.
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('tbody tr td input[type=checkbox]')
    ).toBeNull();
  });

  it('offers the checkbox on a balance that only partly covers the total', async () => {
    apiClient.GET.and.callFake((path: string) => {
      if (path === '/api/v1/wallet/mine/') {
        return Promise.resolve({ data: { balance: '50.00', currency: 'NGN', transactions: [] } });
      }
      return Promise.resolve({ data: { count: 1, results: [makeBooking({ total_amount: '750.00' })] } });
    });

    await createComponent();

    expect(component['canUseWalletBalance'](makeBooking() as never)).toBeTrue();
    const breakdown = component['walletBreakdown'](makeBooking({ total_amount: '750.00' }) as never);
    expect(breakdown?.fullyCovered).toBeFalse();
    expect(breakdown?.walletPortion).toBe('NGN 50.00');
    expect(breakdown?.remainder).toBe('NGN 700.00');
  });

  it('checking the wallet-balance box sends use_wallet_balance and refetches on a succeeded response', async () => {
    apiClient.GET.and.callFake((path: string) => {
      if (path === '/api/v1/wallet/mine/') {
        return Promise.resolve({ data: { balance: '2000.00', currency: 'NGN', transactions: [] } });
      }
      return Promise.resolve({ data: { count: 1, results: [makeBooking()] } });
    });
    await createComponent();
    apiClient.POST.and.resolveTo({
      data: { id: 'intent-1', status: 'succeeded', authorization_url: '', reference: 'wallet-ref-1' },
    });
    apiClient.GET.calls.reset();

    component['toggleUseWalletBalance'](makeBooking() as never, true);
    await component['payNow'](makeBooking() as never);

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/payments/',
      jasmine.objectContaining({
        body: { booking_id: 'booking-1', use_wallet_balance: true },
      })
    );
    expect(apiClient.GET).toHaveBeenCalledWith('/api/v1/bookings/mine/', jasmine.anything());
    expect(component['paymentError']()).toBeNull();
  });

  it('redirects for the remainder when the wallet balance only partly covers a blended payment', async () => {
    apiClient.GET.and.callFake((path: string) => {
      if (path === '/api/v1/wallet/mine/') {
        return Promise.resolve({ data: { balance: '50.00', currency: 'NGN', transactions: [] } });
      }
      return Promise.resolve({ data: { count: 1, results: [makeBooking({ total_amount: '750.00' })] } });
    });
    await createComponent();
    apiClient.POST.and.resolveTo({
      data: {
        id: 'intent-1',
        status: 'pending',
        authorization_url: 'https://paystack.test/pay/remainder',
        reference: 'ref-2',
      },
    });
    const redirect = spyOn(component as unknown as WithRedirect, 'redirectToPaystack');

    component['toggleUseWalletBalance'](makeBooking({ total_amount: '750.00' }) as never, true);
    await component['payNow'](makeBooking({ total_amount: '750.00' }) as never);

    expect(redirect).toHaveBeenCalledWith('https://paystack.test/pay/remainder');
  });

  it('shows the server message when a blended payment fails', async () => {
    apiClient.GET.and.callFake((path: string) => {
      if (path === '/api/v1/wallet/mine/') {
        return Promise.resolve({ data: { balance: '2000.00', currency: 'NGN', transactions: [] } });
      }
      return Promise.resolve({ data: { count: 1, results: [makeBooking()] } });
    });
    await createComponent();
    apiClient.POST.and.resolveTo({
      error: { detail: 'Your wallet balance is not enough to pay for this booking.' },
    });

    component['toggleUseWalletBalance'](makeBooking() as never, true);
    await component['payNow'](makeBooking() as never);

    expect(component['paymentError']()).toBe(
      'Your wallet balance is not enough to pay for this booking.'
    );
  });

  it('renders the paid status pill with a view-tickets action and no pay or cancel action', async () => {
    apiClient.GET.and.resolveTo({
      data: { count: 1, results: [makeBooking({ status: 'paid' })] },
    });

    await createComponent();

    // Scoped to the Status column: the Route cell now carries a class
    // pill of its own (spec 15 slice 3), so a bare `ui-status-pill`
    // query picks up whichever comes first in the DOM.
    const pill = (fixture.nativeElement as HTMLElement).querySelector(
      'tbody tr td:nth-child(5) ui-status-pill'
    );
    expect(pill?.textContent?.trim()).toBe('Paid');
    // No Pay button, and nothing status-dependent in the menu but View
    // tickets. "Report a problem" is on every row whatever the status —
    // a trip can go wrong for someone who never paid and for someone
    // whose trip is long over.
    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr td:last-child ui-button')
        .length
    ).toBe(0);
    expect(component['menuItemsFor'](makeBooking({ status: 'paid' }) as never)).toEqual([
      { id: 'tickets', label: 'View tickets', icon: 'document-check' },
      { id: 'track', label: 'Track this trip', icon: 'map-pin' },
      { id: 'report', label: 'Report a problem', icon: 'exclamation-triangle' },
    ]);
  });

  it('renders no view-tickets action on a booking that is not yet paid', async () => {
    await createComponent();

    expect(component['canViewTickets'](makeBooking() as never)).toBeFalse();
  });

  it('navigates to the tickets screen for a paid booking', async () => {
    apiClient.GET.and.resolveTo({
      data: { count: 1, results: [makeBooking({ status: 'paid' })] },
    });
    await createComponent();
    const router = TestBed.inject(Router);
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);

    await component['viewTickets'](makeBooking({ status: 'paid' }) as never);

    expect(navigate).toHaveBeenCalledWith(['/my-bookings', 'booking-1', 'tickets']);
  });

  it('offers "Track this trip" once paid, and still once completed', async () => {
    await createComponent();

    expect(component['canTrack'](makeBooking({ status: 'pending_payment' }) as never)).toBeFalse();
    expect(component['canTrack'](makeBooking({ status: 'paid' }) as never)).toBeTrue();
    expect(component['canTrack'](makeBooking({ status: 'completed' }) as never)).toBeTrue();
    expect(component['canTrack'](makeBooking({ status: 'cancelled' }) as never)).toBeFalse();
  });

  it('navigates to the tracking screen by trip id, not booking id', async () => {
    await createComponent();
    const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);

    await component['onAction'](makeBooking() as never, 'track');

    expect(navigate).toHaveBeenCalledWith(['/trips', 'trip-1', 'track']);
  });

  it('offers "Report a problem" on a booking that was never paid', async () => {
    // The row action is not gated on status. A reader that would not
    // take the card is exactly why a booking stayed unpaid, and hiding
    // the report link there would hide it from the person with the most
    // to report.
    await createComponent();

    expect(component['menuItemsFor'](makeBooking({ status: 'pending_payment' }) as never)).toContain(
      { id: 'report', label: 'Report a problem', icon: 'exclamation-triangle' }
    );
  });

  it('hands the report form the booking id, not the trip id', async () => {
    await createComponent();
    const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);

    await component['onAction'](makeBooking() as never, 'report');

    // `report-issue` resolves the Booking to get the operator and a
    // human label for the trip as well; a trip id alone names none of
    // that.
    expect(navigate).toHaveBeenCalledWith(['/report-issue'], {
      queryParams: { booking: 'booking-1' },
    });
  });

  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', async () => {
    await createComponent();

    expectColumnVisibilityParity(fixture.nativeElement, 'my-bookings');
  });

  // --- hold countdown (docs/specs/21-passenger-experience.md slice 2) ----

  describe('hold countdown', () => {
    it('renders a countdown on a pending_payment row with a live hold', async () => {
      await createComponent();

      const countdown = (fixture.nativeElement as HTMLElement).querySelector('ui-countdown');
      expect(countdown?.textContent).toContain('Held for');
    });

    it('renders no countdown once the hold is null (already paid, or open seating)', async () => {
      apiClient.GET.and.resolveTo({
        data: {
          count: 1,
          results: [makeBooking({ hold_expires_at: null, hold_expires_in_seconds: null })],
        },
      });

      await createComponent();

      const countdown = (fixture.nativeElement as HTMLElement).querySelector('ui-countdown');
      expect(countdown?.textContent?.trim()).toBe('');
    });

    it('reloads the list rather than asserting expiry once a row reaches zero', async () => {
      await createComponent();
      apiClient.GET.calls.reset();

      component['onHoldExpired']();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(apiClient.GET).toHaveBeenCalledWith('/api/v1/bookings/mine/', jasmine.anything());
    });
  });

  /**
   * The pay confirmation, added in spec 14 slice 5.
   *
   * "Pay now" used to charge on one tap, with the wallet option a bare
   * checkbox in the table cell beside it. Money moving is worth one
   * deliberate step and one place to read the amount and the split.
   */
  describe('pay confirmation', () => {
    async function withBalance(balance: string, total = '500.00'): Promise<void> {
      apiClient.GET.and.callFake((path: string) => {
        if (path === '/api/v1/wallet/mine/') {
          return Promise.resolve({ data: { balance, currency: 'NGN', transactions: [] } });
        }
        return Promise.resolve({
          data: { count: 1, results: [makeBooking({ total_amount: total })] },
        });
      });
      await createComponent();
    }

    it('opens a dialog instead of charging immediately', async () => {
      await withBalance('0.00');
      apiClient.POST.calls.reset();

      component['openPayDialog'](makeBooking() as never);

      expect(dialog.open).toHaveBeenCalled();
      expect(apiClient.POST).not.toHaveBeenCalled();
    });

    it('writes nothing if the passenger dismisses it', async () => {
      await withBalance('0.00');
      apiClient.POST.calls.reset();

      component['openPayDialog'](makeBooking() as never);
      // Not calling onConfirm is what dismissing does.

      expect(apiClient.POST).not.toHaveBeenCalled();
    });

    it('is not marked destructive — paying is what the passenger came to do', async () => {
      await withBalance('0.00');

      component['openPayDialog'](makeBooking() as never);

      expect(lastDialogData().danger()).toBeFalse();
      expect(lastDialogData().title).toContain('Ikeja → CMS');
    });

    // A passenger sent to a bank page unannounced is a passenger who
    // abandons the payment.
    it('names Paystack on the button when the card will be charged', async () => {
      await withBalance('0.00');

      component['openPayDialog'](makeBooking() as never);

      expect(lastDialogData().confirmLabel()).toBe('Continue to Paystack');
      expect(component['payOutcomeHint'](makeBooking() as never)).toContain('taken to Paystack');
    });

    it('names the wallet on the button when the balance covers it in full', async () => {
      await withBalance('2000.00');
      component['toggleUseWalletBalance'](makeBooking() as never, true);

      component['openPayDialog'](makeBooking() as never);

      expect(lastDialogData().confirmLabel()).toBe('Pay from wallet');
      expect(component['payOutcomeHint'](makeBooking() as never)).toContain('not leave the app');
    });

    it('still goes to Paystack when the balance only partly covers it', async () => {
      await withBalance('50.00', '750.00');
      component['toggleUseWalletBalance'](makeBooking() as never, true);

      component['openPayDialog'](makeBooking({ total_amount: '750.00' }) as never);

      expect(lastDialogData().confirmLabel()).toBe('Continue to Paystack');
      expect(component['walletExplainer'](makeBooking({ total_amount: '750.00' }) as never)).toBe(
        'NGN 50.00 from your balance, NGN 700.00 on your card.'
      );
    });

    it('charges when confirmed', async () => {
      await withBalance('0.00');
      apiClient.POST.and.resolveTo({
        data: { id: 'intent-1', status: 'succeeded', authorization_url: '', reference: 'r' },
      });

      component['openPayDialog'](makeBooking() as never);
      const result = await lastDialogData().onConfirm();

      expect(apiClient.POST).toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });

    // The dialog stays open on a failure with the message in it, which
    // is the whole contract ui-confirm-dialog provides.
    it('keeps the dialog open and reports why when the charge fails', async () => {
      await withBalance('0.00');
      apiClient.POST.and.resolveTo({ error: { detail: 'This booking is no longer payable.' } });

      component['openPayDialog'](makeBooking() as never);
      const result = await lastDialogData().onConfirm();

      expect(result).toEqual({ ok: false, error: 'This booking is no longer payable.' });
      // ...and on the page behind it, so it survives being dismissed.
      expect(component['paymentError']()).toBe('This booking is no longer payable.');
    });

    // There is no return trip from a payment page to signal success on
    // this path, so the screen has to say so itself.
    it('confirms in place when the wallet covered the whole amount', async () => {
      await withBalance('2000.00');
      component['toggleUseWalletBalance'](makeBooking() as never, true);
      apiClient.POST.and.resolveTo({
        data: { id: 'intent-1', status: 'succeeded', authorization_url: '', reference: 'r' },
      });

      component['openPayDialog'](makeBooking() as never);
      await lastDialogData().onConfirm();
      fixture.detectChanges();

      expect(component['paymentSuccess']()).toContain('from your wallet');
      const alert = (fixture.nativeElement as HTMLElement).querySelector('ui-alert [role="status"]');
      expect(alert?.textContent).toContain('from your wallet');
    });

    // The dialog body is an ng-template rendered by ui-confirm-dialog,
    // which this suite mocks — so what is assertable here is that it is
    // handed over, and that the text it renders is right. That the
    // toggle's description reaches it through `describedBy` rather than
    // as a loose paragraph (spec 10's rule, since ui-toggle renders no
    // text of its own) is markup, and is checked in the visual pass.
    it('hands the dialog a body to render', async () => {
      await withBalance('2000.00');

      component['openPayDialog'](makeBooking() as never);

      expect(lastDialogData().bodyTemplate).toBeTruthy();
    });

    // The whole balance, not the part this booking would consume — a
    // passenger with 2000 in their wallet and a 1500 fare was told they
    // had 1500 available, which is the capped portion wearing the
    // balance's label.
    it('says what the balance is, not what this booking would use', async () => {
      await withBalance('2000.00');

      expect(component['walletExplainer'](makeBooking() as never)).toBe(
        'You have NGN 2000.00 available with this operator.'
      );
    });
  });
});
