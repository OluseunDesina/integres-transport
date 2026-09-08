import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { Dashboard } from './dashboard';
import {
  AdminDashboardStore,
  type Dashboard as DashboardEnvelope,
} from '../shared/data/store/dashboard.store';
import { SelectedBusinessStore } from '../shared/data/store/selected-business.store';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    email: 'owner@example.com',
    firstName: '',
    lastName: '',
    client: 'client-1',
    isPlatformStaff: false,
    isClientStaff: true,
    permissions: ['client-admin:access', 'analytics.view'],
    roleName: 'Owner',
    clientName: null,
    ...overrides,
  };
}

function makeEnvelope(overrides: Partial<DashboardEnvelope> = {}): DashboardEnvelope {
  return {
    period: {
      from: '2026-08-01',
      to: '2026-08-03',
      timezone: 'Africa/Lagos',
      granularity: 'day',
    },
    routes: { active: 12, inactive: 3 },
    trips: {
      scheduled: 40,
      in_progress: 6,
      completed: 22,
      cancelled: 1,
      completed_today: 4,
    },
    bookings: { total: 180, paid: 170, cancelled: 8, pending_payment: 2 },
    incidents: { open: 0 },
    money: [
      {
        currency: 'NGN',
        revenue: '1900.00',
        gross: '2000.00',
        commission: '100.00',
        transaction_volume: 4,
        average_ticket_value: '500.00',
      },
    ],
    trends: {
      revenue: [
        { date: '2026-08-01', currency: 'NGN', amount: '900.00' },
        { date: '2026-08-03', currency: 'NGN', amount: '1000.00' },
      ],
      bookings: [{ date: '2026-08-01', count: 3 }],
    },
    recent_incidents: [],
    recent_transactions: [
      {
        id: 'pay-1',
        business: 'biz-1',
        amount: '500.00',
        currency: 'NGN',
        status: 'succeeded',
        channel: 'card',
        created_at: '2026-08-03T10:00:00Z',
      },
      {
        id: 'pay-2',
        business: 'biz-1',
        amount: '250.00',
        currency: 'NGN',
        status: 'pending',
        channel: '',
        created_at: '2026-08-03T11:00:00Z',
      },
    ],
    ...overrides,
  };
}

class FakeDashboardStore {
  data = signal<DashboardEnvelope | null>(makeEnvelope());
  loading = signal(false);
  error = signal<string | null>(null);
  load = jasmine.createSpy('load').and.resolveTo();
}

class FakeSelectedBusinessStore {
  selectedBusinessId = signal<string | null>('biz-1');
  items = signal<{ id: string; name: string; currency: string }[]>([
    { id: 'biz-1', name: 'Verify Shuttle', currency: 'NGN' },
  ]);
}

describe('Dashboard', () => {
  let fixture: ComponentFixture<Dashboard>;
  let store: FakeDashboardStore;
  let authStore: AuthStore;
  let queryParams: Record<string, string>;

  async function setup(user: Partial<AuthUser> = {}): Promise<void> {
    authStore = TestBed.inject(AuthStore);
    authStore.setSession('a', 'r', makeUser(user));
    fixture = TestBed.createComponent(Dashboard);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  beforeEach(() => {
    localStorage.clear();
    store = new FakeDashboardStore();
    queryParams = {};

    TestBed.configureTestingModule({
      imports: [Dashboard],
      providers: [
        provideRouter([]),
        { provide: AdminDashboardStore, useValue: store },
        { provide: SelectedBusinessStore, useValue: new FakeSelectedBusinessStore() },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { queryParamMap: { get: (key: string) => queryParams[key] ?? null } },
          },
        },
      ],
    });
  });

  afterEach(() => localStorage.clear());

  describe('permission handling', () => {
    it('loads the dashboard for a user who holds analytics.view', async () => {
      await setup();

      expect(store.load).toHaveBeenCalledWith({
        business: 'biz-1',
        date_from: undefined,
        date_to: undefined,
        granularity: 'day',
      });
    });

    it('makes no request at all for a Staff user, and says why', async () => {
      // `/home` is where every client-admin user lands after signing in,
      // so this screen must render *something* for a role that cannot
      // see revenue — a Forbidden page on login is not an option.
      await setup({ permissions: ['client-admin:access'], roleName: 'Staff' });

      expect(store.load).not.toHaveBeenCalled();
      expect(text()).toContain('Analytics are not part of your role');
      expect(text()).not.toContain('Net revenue');
    });
  });

  describe('the three states the period echo exists to separate', () => {
    it('renders an error inline, not only in a toast', async () => {
      store.error.set('Range longer than 92 days; use granularity=week.');
      store.data.set(null);
      await setup();

      const alert = fixture.debugElement.query(By.css('ui-alert'));
      expect(alert).not.toBeNull();
      expect(alert.nativeElement.textContent).toContain('use granularity=week');
    });

    it('renders skeletons while loading, and no figures', async () => {
      store.loading.set(true);
      store.data.set(null);
      await setup();

      expect(fixture.debugElement.queryAll(By.css('ui-skeleton')).length).toBeGreaterThan(0);
      expect(text()).not.toContain('Net revenue');
    });

    it('distinguishes an answered-but-empty period from an error', async () => {
      store.data.set(
        makeEnvelope({
          money: [],
          bookings: { total: 0, paid: 0, cancelled: 0, pending_payment: 0 },
          trends: { revenue: [], bookings: [] },
          recent_transactions: [],
        })
      );
      await setup();

      expect(text()).toContain('Nothing to report for this period');
      // The period still renders: that is what says the request succeeded.
      expect(text()).toContain('2026-08-01');
      expect(fixture.debugElement.query(By.css('ui-alert'))).toBeNull();
    });
  });

  describe('money', () => {
    it('renders net revenue, gross and commission for the currency', async () => {
      await setup();

      expect(text()).toContain('NGN 1900.00');
      expect(text()).toContain('NGN 2000.00');
      expect(text()).toContain('NGN 100.00');
    });

    it('renders one stat block and one chart per currency, never merged', async () => {
      // A Client can run an NGN and a BWP Business at once. Adding those
      // two numbers produces a figure that is not money — and putting
      // them on one value axis is the visual form of the same mistake.
      store.data.set(
        makeEnvelope({
          money: [
            {
              currency: 'NGN',
              revenue: '1900.00',
              gross: '2000.00',
              commission: '100.00',
              transaction_volume: 4,
              average_ticket_value: '500.00',
            },
            {
              currency: 'BWP',
              revenue: '80.00',
              gross: '90.00',
              commission: '10.00',
              transaction_volume: 1,
              average_ticket_value: '90.00',
            },
          ],
          trends: {
            revenue: [
              { date: '2026-08-01', currency: 'NGN', amount: '900.00' },
              { date: '2026-08-01', currency: 'BWP', amount: '80.00' },
            ],
            bookings: [],
          },
        })
      );
      await setup();

      expect(text()).toContain('Revenue · NGN');
      expect(text()).toContain('Revenue · BWP');
      // Two revenue charts plus the bookings chart.
      expect(fixture.debugElement.queryAll(By.css('ui-chart')).length).toBe(3);
    });

    it('gives each currency only its own trend points', async () => {
      store.data.set(
        makeEnvelope({
          money: [
            {
              currency: 'NGN',
              revenue: '900.00',
              gross: '1000.00',
              commission: '100.00',
              transaction_volume: 1,
              average_ticket_value: '1000.00',
            },
          ],
          trends: {
            revenue: [
              { date: '2026-08-01', currency: 'NGN', amount: '900.00' },
              { date: '2026-08-02', currency: 'BWP', amount: '77.00' },
            ],
            bookings: [],
          },
        })
      );
      await setup();

      const chartTable = fixture.debugElement.query(By.css('ui-chart table'))
        .nativeElement as HTMLElement;
      expect(chartTable.textContent).toContain('NGN 900.00');
      expect(chartTable.textContent).not.toContain('77');
    });
  });

  describe('charts', () => {
    it('marks a bucket the endpoint omitted as a gap, not a zero', async () => {
      await setup();

      // 2026-08-02 is absent from `trends.revenue`; the axis still runs
      // 01 → 03, and the missing day reads as missing.
      const chartTable = fixture.debugElement.query(By.css('ui-chart table'))
        .nativeElement as HTMLElement;
      const rows = Array.from(chartTable.querySelectorAll('tbody tr')).map((tr) =>
        Array.from(tr.children).map((cell) => cell.textContent?.trim())
      );
      expect(rows).toEqual([
        ['2026-08-01', 'NGN 900.00'],
        ['2026-08-02', 'No data'],
        ['2026-08-03', 'NGN 1000.00'],
      ]);
    });

    it('renders an accessible data table for every chart on the screen', async () => {
      await setup();

      const charts = fixture.debugElement.queryAll(By.css('ui-chart'));
      expect(charts.length).toBe(2);
      for (const chart of charts) {
        expect(chart.query(By.css('table.sr-only'))).not.toBeNull();
      }
    });
  });

  describe('operations and transactions', () => {
    it('renders the operational counts', async () => {
      await setup();

      expect(text()).toContain('Active routes');
      expect(text()).toContain('Trips completed today');
      expect(text()).toContain('Open incidents');
    });

    it('reports a captured channel, and a blank one as unknown', async () => {
      // Every payment predating spec 16 slice 1 has a blank channel.
      // Guessing `card` for them would be inventing data.
      await setup();

      // Scoped to the real table: every chart also renders a
      // visually-hidden one, and `tbody tr` alone finds those first.
      const rows = fixture.debugElement.queryAll(By.css('ui-table tbody tr'));
      expect(rows[0].nativeElement.textContent).toContain('card');
      expect(rows[1].nativeElement.textContent).toContain('unknown');
    });
  });

  describe('filters', () => {
    it('seeds the period from the URL so a filtered view is linkable', async () => {
      queryParams = { date_from: '2026-07-01', date_to: '2026-07-31', granularity: 'week' };
      await setup();

      expect(store.load).toHaveBeenCalledWith({
        business: 'biz-1',
        date_from: '2026-07-01',
        date_to: '2026-07-31',
        granularity: 'week',
      });
    });

    it('ignores a hand-edited URL rather than sending it as a 400', async () => {
      queryParams = { date_from: 'last-tuesday', granularity: 'fortnight' };
      await setup();

      expect(store.load).toHaveBeenCalledWith({
        business: 'biz-1',
        date_from: undefined,
        date_to: undefined,
        granularity: 'day',
      });
    });

    it('refetches and writes the period back to the URL when it changes', async () => {
      await setup();
      const router = TestBed.inject(Router);
      const navigate = spyOn(router, 'navigate').and.resolveTo(true);
      store.load.calls.reset();

      const from = fixture.debugElement.queryAll(By.css('input[type="date"]'))[0]
        .nativeElement as HTMLInputElement;
      from.value = '2026-08-10';
      from.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      await fixture.whenStable();

      expect(store.load).toHaveBeenCalledWith(
        jasmine.objectContaining({ date_from: '2026-08-10' })
      );
      expect(navigate).toHaveBeenCalledWith(
        [],
        jasmine.objectContaining({
          queryParams: { date_from: '2026-08-10', date_to: null, granularity: null },
          replaceUrl: true,
        })
      );
    });

    it('shows an active period as a removable chip', async () => {
      queryParams = { date_from: '2026-07-01' };
      await setup();

      expect(text()).toContain('From: 2026-07-01');
    });
  });
});
