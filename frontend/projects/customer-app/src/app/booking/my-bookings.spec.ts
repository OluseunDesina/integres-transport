import { Dialog } from '@angular/cdk/dialog';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
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
    expect(cells[0]).toBe('Ikeja → CMS');
    expect(cells[1]).not.toBe('trip-1');
    expect(cells[2]).toBe('1A, 1B');
    expect(cells[3]).toBe('NGN 1500.00');
  });

  it('shows an empty state before any booking exists', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await createComponent();

    expect((fixture.nativeElement as HTMLElement).querySelector('ui-empty-state')).toBeTruthy();
  });

  it('offers cancel on a pending_payment booking', async () => {
    await createComponent();

    expect(component['canCancel'](makeBooking() as never)).toBeTrue();
    // Pay now renders first in the actions cell, Cancel second — see
    // "offers pay now on a pending_payment booking" for the former.
    const actions = (fixture.nativeElement as HTMLElement).querySelectorAll(
      'tbody tr td:last-child ui-button'
    );
    expect(actions[actions.length - 1]?.textContent?.trim()).toBe('Cancel');
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

  it('offers pay now on a pending_payment booking', async () => {
    await createComponent();

    expect(component['canPay'](makeBooking() as never)).toBeTrue();
    const actions = (fixture.nativeElement as HTMLElement).querySelectorAll(
      'tbody tr td:last-child ui-button'
    );
    expect(actions[0]?.textContent?.trim()).toBe('Pay now');
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
        body: { booking_id: 'booking-1' },
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
    expect(component['canPayFromWallet'](makeBooking() as never)).toBeTrue();
  });

  it('does not offer pay-from-wallet when the balance is short', async () => {
    apiClient.GET.and.callFake((path: string) => {
      if (path === '/api/v1/wallet/mine/') {
        return Promise.resolve({ data: { balance: '10.00', currency: 'NGN', transactions: [] } });
      }
      return Promise.resolve({ data: { count: 1, results: [makeBooking()] } });
    });

    await createComponent();

    expect(component['canPayFromWallet'](makeBooking() as never)).toBeFalse();
    const actions = (fixture.nativeElement as HTMLElement).querySelectorAll(
      'tbody tr td:last-child ui-button'
    );
    expect(Array.from(actions).some((btn) => btn.textContent?.trim() === 'Pay from wallet')).toBeFalse();
  });

  it('pays from wallet and refetches the list on success', async () => {
    apiClient.GET.and.callFake((path: string) => {
      if (path === '/api/v1/wallet/mine/') {
        return Promise.resolve({ data: { balance: '2000.00', currency: 'NGN', transactions: [] } });
      }
      return Promise.resolve({ data: { count: 1, results: [makeBooking()] } });
    });
    await createComponent();
    apiClient.POST.and.resolveTo({ data: makeBooking({ status: 'paid' }) });
    apiClient.GET.calls.reset();

    await component['payFromWallet'](makeBooking() as never);

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/bookings/{id}/pay-from-wallet/',
      jasmine.objectContaining({ params: { path: { id: 'booking-1' } } })
    );
    expect(apiClient.GET).toHaveBeenCalledWith('/api/v1/bookings/mine/', jasmine.anything());
    expect(component['paymentError']()).toBeNull();
  });

  it('shows the server message when paying from wallet fails', async () => {
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

    await component['payFromWallet'](makeBooking() as never);

    expect(component['paymentError']()).toBe(
      'Your wallet balance is not enough to pay for this booking.'
    );
  });

  it('renders the paid status pill with a view-tickets action and no pay or cancel action', async () => {
    apiClient.GET.and.resolveTo({
      data: { count: 1, results: [makeBooking({ status: 'paid' })] },
    });

    await createComponent();

    const pill = (fixture.nativeElement as HTMLElement).querySelector('ui-status-pill');
    expect(pill?.textContent?.trim()).toBe('Paid');
    const actions = (fixture.nativeElement as HTMLElement).querySelectorAll(
      'tbody tr td:last-child ui-button'
    );
    expect(actions.length).toBe(1);
    expect(actions[0]?.textContent?.trim()).toBe('View tickets');
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
});
