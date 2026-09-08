import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { AdminDashboardStore } from './dashboard.store';

const ENVELOPE = {
  period: { from: '2026-08-01', to: '2026-08-30', timezone: 'Africa/Lagos', granularity: 'day' },
  routes: { active: 1, inactive: 0 },
  trips: { scheduled: 0, in_progress: 0, completed: 0, cancelled: 0, completed_today: 0 },
  bookings: { total: 0, paid: 0, cancelled: 0, pending_payment: 0 },
  incidents: { open: 0 },
  money: [],
  trends: { revenue: [], bookings: [] },
  recent_incidents: [],
  recent_transactions: [],
};

describe('AdminDashboardStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: AdminDashboardStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };
    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });
    store = TestBed.inject(AdminDashboardStore);
  });

  it('passes the whole filter set through to the endpoint', async () => {
    apiClient.GET.and.resolveTo({ data: ENVELOPE });

    await store.load({
      business: 'biz-1',
      date_from: '2026-08-01',
      date_to: '2026-08-30',
      granularity: 'week',
    });

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/analytics/dashboard/',
      jasmine.objectContaining({
        params: {
          query: {
            business: 'biz-1',
            date_from: '2026-08-01',
            date_to: '2026-08-30',
            granularity: 'week',
          },
        },
      })
    );
    expect(store.data()).toEqual(ENVELOPE as never);
    expect(store.error()).toBeNull();
  });

  describe('overlapping requests', () => {
    // Found live, not reasoned about: filling two date fields in a row
    // issues two requests, and a 400 comes back long before a real
    // aggregation does. The screen showed a *successful* dashboard for
    // the older range with no error, while the period line disagreed
    // with the date fields above it.

    function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
      let resolve!: (value: unknown) => void;
      const promise = new Promise<unknown>((r) => (resolve = r));
      return { promise, resolve };
    }

    it('lets only the newest response write, whatever order they land in', async () => {
      const first = deferred();
      const second = deferred();
      apiClient.GET.and.returnValues(first.promise, second.promise);

      const a = store.load({ date_to: '2026-08-30' });
      const b = store.load({ date_from: '2026-08-31', date_to: '2026-08-01' });

      // The newer request answers first (a validation error is cheap)…
      second.resolve({ error: { date_from: ['date_from must not be after date_to.'] } });
      await b;
      // …and the older, slower one lands afterwards.
      first.resolve({ data: ENVELOPE });
      await a;

      expect(store.error()).toBe('date_from must not be after date_to.');
      expect(store.data()).toBeNull();
    });

    it('keeps loading true while a newer request is still in flight', async () => {
      const first = deferred();
      const second = deferred();
      apiClient.GET.and.returnValues(first.promise, second.promise);

      const a = store.load({});
      const b = store.load({});

      first.resolve({ data: ENVELOPE });
      await a;
      expect(store.loading()).toBeTrue();

      second.resolve({ data: ENVELOPE });
      await b;
      expect(store.loading()).toBeFalse();
    });
  });

  describe('error messages', () => {
    // Every 400 this screen can provoke comes from
    // AnalyticsFilterSerializer and is field-keyed, not `{detail}`.
    // Reading `detail` alone — this store's first version — flattened a
    // message naming the exact fix into "failed to load". Confirmed
    // against the running backend, not assumed.

    it('surfaces a field-keyed validation error verbatim', async () => {
      apiClient.GET.and.resolveTo({
        error: {
          granularity: [
            'A day trend covers at most 92 days; this range is 97. Use granularity=week for a longer range.',
          ],
        },
      });

      await store.load({});

      expect(store.error()).toBe(
        'A day trend covers at most 92 days; this range is 97. Use granularity=week for a longer range.'
      );
    });

    it('surfaces a reversed range against whichever field carries it', async () => {
      apiClient.GET.and.resolveTo({
        error: { date_from: ['date_from must not be after date_to.'] },
      });

      await store.load({});

      expect(store.error()).toBe('date_from must not be after date_to.');
    });

    it('still prefers a plain detail when one is present', async () => {
      apiClient.GET.and.resolveTo({
        error: { detail: 'You do not have permission to perform this action.' },
      });

      await store.load({});

      expect(store.error()).toBe('You do not have permission to perform this action.');
    });

    it('falls back to a readable message for a shape it does not recognise', async () => {
      apiClient.GET.and.resolveTo({ error: undefined });

      await store.load({});

      expect(store.error()).toBe('Failed to load the dashboard.');
    });

    it('clears the previous envelope rather than leaving a stale total on screen', async () => {
      apiClient.GET.and.resolveTo({ data: ENVELOPE });
      await store.load({});
      expect(store.data()).not.toBeNull();

      apiClient.GET.and.resolveTo({ error: { date_to: ['Bad.'] } });
      await store.load({});

      // A total beside "this range is too long" reads as the answer to
      // the question just asked.
      expect(store.data()).toBeNull();
      expect(store.error()).toBe('Bad.');
    });
  });
});
