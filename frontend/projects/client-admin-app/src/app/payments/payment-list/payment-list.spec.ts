import { expectColumnVisibilityParity } from '@shared-ui';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { PaymentList } from './payment-list';
import { ExportStore } from '../../shared/data/store/export.store';
import { PaymentSummaryStore } from '../../shared/data/store/payment-summary.store';
import {
  PaymentIntentStore,
  type PaymentIntent,
} from '../../shared/data/store/payment-intent.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

function makePaymentIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'payment-1',
    intent_type: 'booking_payment',
    booking: 'booking-1234-5678',
    wallet_business: null,
    business: 'biz-1',
    passenger: 'user-1',
    amount: '1500.00',
    // The wallet-funded slice of a blended wallet + Paystack payment;
    // '0.00' for an ordinary card-only intent like this fixture.
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

class FakeSummaryStore {
  data = signal<Record<string, unknown> | null>(null);
  loading = signal(false);
  error = signal<string | null>(null);
  load = jasmine.createSpy('load').and.resolveTo();
}

class FakeExportStore {
  error = signal<string | null>(null);
  download = jasmine.createSpy('download').and.resolveTo();
  isPending = () => false;
}

describe('PaymentList', () => {
  let summary: FakeSummaryStore;
  let exports: FakeExportStore;

  let fixture: ComponentFixture<PaymentList>;
  let store: FakePaymentIntentStore;

  beforeEach(async () => {
    store = new FakePaymentIntentStore();

    summary = new FakeSummaryStore();
    exports = new FakeExportStore();
    await TestBed.configureTestingModule({
      imports: [PaymentList],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: { GET: jasmine.createSpy('GET').and.resolveTo({}) } },
        { provide: PaymentIntentStore, useValue: store },
        { provide: PaymentSummaryStore, useValue: summary },
        { provide: ExportStore, useValue: exports },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: { get: () => null } } },
        },
        {
          provide: SelectedBusinessStore,
          useValue: new FakeSelectedBusinessStore(),
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PaymentList);
    fixture.detectChanges();
  });

  it('scopes the query to the active Business on init', () => {
    expect(store.updateQuery).toHaveBeenCalledWith(
      jasmine.objectContaining({ business: 'biz-1' })
    );
    // The strip is refreshed from the same query as the table, which is
    // the frontend half of "the numbers above a table describe the rows
    // in it".
    expect(summary.load).toHaveBeenCalledWith(
      jasmine.objectContaining({ business: 'biz-1' })
    );
  });

  it('shows the empty state when the store has no rows', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No payments yet');
  });

  it('renders a row per payment with amount and status', () => {
    store.items.set([
      makePaymentIntent(),
      makePaymentIntent({ id: 'payment-2', status: 'failed' }),
    ]);
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

    expect(store.updateQuery).toHaveBeenCalledWith(
      jasmine.objectContaining({ business: 'biz-1', status: 'failed' })
    );
  });

  it('calls store.changePage() when the paginator emits', () => {
    store.items.set([makePaymentIntent()]);
    store.total.set(30);
    fixture.detectChanges();

    const buttons = fixture.debugElement.queryAll(By.css('button'));
    const nextButton = buttons.find((b) =>
      (b.nativeElement.textContent as string).includes('Next')
    );
    nextButton?.nativeElement.click();

    expect(store.changePage).toHaveBeenCalledWith(25);
  });
  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', () => {
    store.items.set([makePaymentIntent()]);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'payment-list rows');
  });

  it('keeps the skeleton row aligned with the header too', () => {
    store.loading.set(true);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'payment-list skeleton');
  });
});
