import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { expectColumnVisibilityParity } from '@shared-ui';
import { By } from '@angular/platform-browser';

import { Payments } from './payments';
import { PaymentIntentStore, type PaymentIntent } from '../shared/data/store/payment-intent.store';

function makePaymentIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'payment-1',
    intent_type: 'booking_payment',
    booking: 'booking-1',
    wallet_business: null,
    business: 'biz-1',
    passenger: 'user-1',
    amount: '750.00',
    wallet_component_amount: '0.00',
    currency: 'NGN',
    status: 'succeeded',
    psp_provider: 'paystack',
    psp_reference: 'ref-1',
    psp_authorization_url: '',
    // docs/specs/16-operational-analytics.md slice 1 — blank is
    // what every intent that never succeeded carries.
    channel: '',
    succeeded_at: '2026-08-10T00:00:00Z',
    failed_at: null,
    requires_manual_refund: false,
    created_at: '2026-08-10T00:00:00Z',
    ...overrides,
  };
}

class FakePaymentIntentStore {
  items = signal<PaymentIntent[]>([]);
  total = signal(0);
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

describe('Payments', () => {
  let fixture: ComponentFixture<Payments>;
  let store: FakePaymentIntentStore;

  beforeEach(async () => {
    store = new FakePaymentIntentStore();

    await TestBed.configureTestingModule({
      imports: [Payments],
      providers: [{ provide: PaymentIntentStore, useValue: store }],
    }).compileComponents();

    fixture = TestBed.createComponent(Payments);
    fixture.detectChanges();
  });

  it('loads payments on init', () => {
    expect(store.getAll).toHaveBeenCalled();
  });

  it('shows the empty state when the store has no rows', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No payments yet');
  });

  it('renders a row per payment with amount and status', () => {
    store.items.set([makePaymentIntent(), makePaymentIntent({ id: 'payment-2', status: 'failed' })]);
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0].nativeElement.textContent).toContain('NGN 750.00');
    expect(rows[1].nativeElement.textContent).toContain('Failed');
  });

  it('calls store.changePage() when the paginator emits', () => {
    store.items.set([makePaymentIntent()]);
    store.total.set(30);
    fixture.detectChanges();

    const buttons = fixture.debugElement.queryAll(By.css('button'));
    const nextButton = buttons.find((b) => (b.nativeElement.textContent as string).includes('Next'));
    nextButton?.nativeElement.click();

    expect(store.changePage).toHaveBeenCalledWith(25);
  });
  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', () => {
    store.items.set([makePaymentIntent()]);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'payments');
  });

});
