import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { PaymentList } from './payment-list';
import { PaymentIntentStore, type PaymentIntent } from '../../shared/data/store/payment-intent.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

function makePaymentIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'payment-1',
    booking: 'booking-1234-5678',
    business: 'biz-1',
    passenger: 'user-1',
    amount: '1500.00',
    currency: 'NGN',
    status: 'succeeded',
    psp_provider: 'paystack',
    psp_reference: 'ref-1',
    psp_authorization_url: '',
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
  query = signal<{ business?: string; status?: string }>({});
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  updateQuery = jasmine.createSpy('updateQuery').and.callFake((partial: object) => {
    this.query.set({ ...this.query(), ...partial });
    return Promise.resolve();
  });
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

class FakeSelectedBusinessStore {
  selectedBusinessId = signal<string | null>('biz-1');
}

describe('PaymentList', () => {
  let fixture: ComponentFixture<PaymentList>;
  let store: FakePaymentIntentStore;

  beforeEach(async () => {
    store = new FakePaymentIntentStore();

    await TestBed.configureTestingModule({
      imports: [PaymentList],
      providers: [
        { provide: PaymentIntentStore, useValue: store },
        { provide: SelectedBusinessStore, useValue: new FakeSelectedBusinessStore() },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PaymentList);
    fixture.detectChanges();
  });

  it('scopes the query to the active Business on init', () => {
    expect(store.updateQuery).toHaveBeenCalledWith({ business: 'biz-1' });
  });

  it('shows the empty state when the store has no rows', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No payments found');
  });

  it('renders a row per payment with amount and status', () => {
    store.items.set([makePaymentIntent(), makePaymentIntent({ id: 'payment-2', status: 'failed' })]);
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0].nativeElement.textContent).toContain('NGN 1500.00');
    expect(rows[1].nativeElement.textContent).toContain('Failed');
  });

  it('shows the server error message instead of the table', () => {
    store.error.set('Failed to load payments.');
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('table'))).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Failed to load payments.');
  });

  it('calls store.updateQuery() with the chosen status filter', () => {
    const select: HTMLSelectElement = fixture.debugElement.query(By.css('select')).nativeElement;
    select.value = 'failed';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(store.updateQuery).toHaveBeenCalledWith({ status: 'failed' });
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
});
