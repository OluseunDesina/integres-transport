import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { ActivityStore } from './activity.store';

function entry(overrides: Record<string, unknown> = {}) {
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
  };
}

describe('ActivityStore', () => {
  let api: { GET: jasmine.Spy };
  let store: ActivityStore;

  beforeEach(() => {
    api = { GET: jasmine.createSpy('GET') };
    TestBed.configureTestingModule({ providers: [{ provide: API_CLIENT, useValue: api }] });
    store = TestBed.inject(ActivityStore);
  });

  it('is loading until the first poll settles', () => {
    expect(store.loading()).toBeTrue();
  });

  it('lists entries and the server-named poll interval after a poll', async () => {
    api.GET.and.resolveTo({ data: { results: [entry()], poll_interval_seconds: 45 } });

    await store.poll();

    expect(api.GET).toHaveBeenCalledWith('/api/v1/activity/mine/', {});
    expect(store.entries().length).toBe(1);
    expect(store.loading()).toBeFalse();
    expect(store.pollIntervalSeconds()).toBe(45);
  });

  it('is empty only once settled with no entries', async () => {
    expect(store.isEmpty()).toBeFalse();

    api.GET.and.resolveTo({ data: { results: [], poll_interval_seconds: 30 } });
    await store.poll();

    expect(store.isEmpty()).toBeTrue();
  });

  it('reports an error and no entries on a first-poll failure', async () => {
    api.GET.and.resolveTo({ data: undefined, error: { detail: 'Server error' } });

    await store.poll();

    expect(store.error()).toBe('Server error');
    expect(store.entries()).toEqual([]);
  });

  it('surfaces a later poll failure without blanking the list', async () => {
    api.GET.and.resolveTo({ data: { results: [entry()], poll_interval_seconds: 30 } });
    await store.poll();

    api.GET.and.resolveTo({ data: undefined, error: { detail: 'Timed out' } });
    await store.poll();

    expect(store.error()).toBeNull();
    expect(store.pollError()).toBe('Timed out');
    expect(store.entries().length).toBe(1);
  });
});
