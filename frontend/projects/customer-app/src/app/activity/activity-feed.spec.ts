import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Poller } from '@shared-data';

import { ActivityFeed } from './activity-feed';
import { ActivityStore, type ActivityEntry } from '../shared/data/store/activity.store';

function entry(overrides: Record<string, unknown> = {}): ActivityEntry {
  return {
    type: 'wallet_topup',
    occurred_at: '2026-09-07T07:00:00Z',
    business: 'Integra Lagos',
    route: null,
    reference: null,
    amount: '500.00',
    currency: 'NGN',
    wallet_balance: '500.00',
    ...overrides,
  } as ActivityEntry;
}

class FakeActivityStore {
  entries = signal<ActivityEntry[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);
  pollError = signal<string | null>(null);
  isEmpty = signal(false);
  pollIntervalSeconds = signal(30);
  poll = jasmine.createSpy('poll').and.resolveTo();
}

describe('ActivityFeed', () => {
  let fixture: ComponentFixture<ActivityFeed>;
  let store: FakeActivityStore;

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function setup(): void {
    store = new FakeActivityStore();
    TestBed.configureTestingModule({
      imports: [ActivityFeed],
      providers: [{ provide: ActivityStore, useValue: store }],
    });
    fixture = TestBed.createComponent(ActivityFeed);
  }

  afterEach(() => {
    fixture.destroy();
  });

  it('shows a loading skeleton while the first poll is outstanding', () => {
    setup();
    store.loading.set(true);
    fixture.detectChanges();

    expect(el().querySelector('ui-skeleton')).not.toBeNull();
  });

  it('shows an empty state once settled with no activity', () => {
    setup();
    store.loading.set(false);
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(el().textContent).toContain('No activity yet');
  });

  it('titles a row with its route when one applies', () => {
    setup();
    store.loading.set(false);
    store.entries.set([entry({ type: 'booking_paid', route: 'Ikeja → CMS', amount: '2400.00' })]);
    fixture.detectChanges();

    expect(el().textContent).toContain('Booking paid — Ikeja → CMS');
    expect(el().textContent).toContain('NGN 2400.00');
  });

  it('omits the route from the title when there is none', () => {
    setup();
    store.loading.set(false);
    store.entries.set([entry()]);
    fixture.detectChanges();

    expect(el().textContent).toContain('Wallet top-up');
    expect(el().textContent).not.toContain('Wallet top-up —');
  });

  it('shows the wallet balance only when the entry carries one', () => {
    setup();
    store.loading.set(false);
    store.entries.set([
      entry({ type: 'ticket_boarded', route: 'Ikeja → CMS', amount: null, currency: null, wallet_balance: null }),
    ]);
    fixture.detectChanges();

    expect(el().textContent).not.toContain('Wallet balance');
  });

  it('surfaces a poll failure without blanking the list', () => {
    setup();
    store.loading.set(false);
    store.entries.set([entry()]);
    store.pollError.set('Timed out');
    fixture.detectChanges();

    expect(el().textContent).toContain('Timed out');
    expect(el().textContent).toContain('Wallet top-up');
  });

  it('starts polling on init and stops for good on teardown', () => {
    spyOn(Poller.prototype, 'start').and.callThrough();
    spyOn(Poller.prototype, 'destroy').and.callThrough();
    setup();
    fixture.detectChanges();

    expect(Poller.prototype.start).toHaveBeenCalledTimes(1);

    fixture.destroy();
    expect(Poller.prototype.destroy).toHaveBeenCalledTimes(1);
  });
});
