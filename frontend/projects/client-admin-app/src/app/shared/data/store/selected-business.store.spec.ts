import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { SelectedBusinessStore, type Business } from './selected-business.store';

function makeBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: 'biz-1',
    vertical: 'shuttle',
    name: 'Acme Shuttle Co',
    currency: 'NGN',
    timezone: 'Africa/Lagos',
    booking_mode_default: 'reservation',
    kyb_status: 'approved',
    kyb_submitted_at: null,
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

describe('SelectedBusinessStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: SelectedBusinessStore;

  beforeEach(() => {
    localStorage.clear();
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(SelectedBusinessStore);
  });

  afterEach(() => localStorage.clear());

  it('starts with no selection until ensureLoaded() resolves', () => {
    expect(store.selectedBusinessId()).toBeNull();
    expect(store.items()).toEqual([]);
  });

  it('defaults to the first Business when nothing is persisted', async () => {
    const businesses = [makeBusiness({ id: 'biz-1' }), makeBusiness({ id: 'biz-2' })];
    apiClient.GET.and.resolveTo({ data: { count: 2, results: businesses } });

    await store.ensureLoaded();

    expect(store.items()).toEqual(businesses);
    expect(store.selectedBusinessId()).toBe('biz-1');
    expect(localStorage.getItem('integra.business.selected')).toBe('"biz-1"');
  });

  it('ensureLoaded() only fetches once across repeated calls', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeBusiness()] } });

    await Promise.all([store.ensureLoaded(), store.ensureLoaded(), store.ensureLoaded()]);

    expect(apiClient.GET).toHaveBeenCalledTimes(1);
  });

  it('select() updates the signal and persists the choice', async () => {
    const businesses = [makeBusiness({ id: 'biz-1' }), makeBusiness({ id: 'biz-2' })];
    apiClient.GET.and.resolveTo({ data: { count: 2, results: businesses } });
    await store.ensureLoaded();

    await store.select('biz-2');

    expect(store.selectedBusinessId()).toBe('biz-2');
    expect(localStorage.getItem('integra.business.selected')).toBe('"biz-2"');
  });

  it('restores a persisted selection that still exists in the fresh list', async () => {
    // The store reads localStorage synchronously at construction
    // (restore()), so the persisted value must exist before the store
    // is injected — re-create the testing module, matching
    // NavCollapseStore's own spec's "restores on construction" pattern.
    localStorage.setItem('integra.business.selected', JSON.stringify('biz-2'));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: API_CLIENT, useValue: apiClient }] });
    const restored = TestBed.inject(SelectedBusinessStore);
    const businesses = [makeBusiness({ id: 'biz-1' }), makeBusiness({ id: 'biz-2' })];
    apiClient.GET.and.resolveTo({ data: { count: 2, results: businesses } });

    await restored.ensureLoaded();

    expect(restored.selectedBusinessId()).toBe('biz-2');
  });

  it('falls back to the first Business when the persisted id no longer exists', async () => {
    localStorage.setItem('integra.business.selected', JSON.stringify('archived-biz'));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: API_CLIENT, useValue: apiClient }] });
    const restored = TestBed.inject(SelectedBusinessStore);
    const businesses = [makeBusiness({ id: 'biz-1' })];
    apiClient.GET.and.resolveTo({ data: { count: 1, results: businesses } });

    await restored.ensureLoaded();

    expect(restored.selectedBusinessId()).toBe('biz-1');
    expect(localStorage.getItem('integra.business.selected')).toBe('"biz-1"');
  });

  it('pages through the entire list rather than trusting a single page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeBusiness({ id: `biz-${i}` }));
    const page2 = [makeBusiness({ id: 'biz-100' })];
    apiClient.GET.and.callFake((_url: string, options: { params: { query: { offset: number } } }) => {
      const { offset } = options.params.query;
      if (offset === 0) {
        return Promise.resolve({ data: { count: 101, results: page1 } });
      }
      return Promise.resolve({ data: { count: 101, results: page2 } });
    });

    await store.ensureLoaded();

    expect(apiClient.GET).toHaveBeenCalledTimes(2);
    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/businesses/',
      jasmine.objectContaining({ params: { query: { limit: 100, offset: 0 } } })
    );
    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/businesses/',
      jasmine.objectContaining({ params: { query: { limit: 100, offset: 100 } } })
    );
    expect(store.items().length).toBe(101);
  });

  it('resolves a persisted id that only exists past the first page — the actual bug this fixes', async () => {
    localStorage.setItem('integra.business.selected', JSON.stringify('biz-100'));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: API_CLIENT, useValue: apiClient }] });
    const restored = TestBed.inject(SelectedBusinessStore);
    const page1 = Array.from({ length: 100 }, (_, i) => makeBusiness({ id: `biz-${i}` }));
    const page2 = [makeBusiness({ id: 'biz-100' })];
    apiClient.GET.and.callFake((_url: string, options: { params: { query: { offset: number } } }) => {
      const { offset } = options.params.query;
      return Promise.resolve({
        data: { count: 101, results: offset === 0 ? page1 : page2 },
      });
    });

    await restored.ensureLoaded();

    // Before this fix, a single limit=100 fetch would never see
    // biz-100 at all and would silently fall back to biz-0 instead.
    expect(restored.selectedBusinessId()).toBe('biz-100');
  });

  it('resolves to no selection when the Client has zero Businesses', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await store.ensureLoaded();

    expect(store.selectedBusinessId()).toBeNull();
    expect(store.items()).toEqual([]);
  });

  it('ignores corrupt persisted data instead of throwing', async () => {
    localStorage.setItem('integra.business.selected', 'not-json');
    apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeBusiness()] } });

    await store.ensureLoaded();

    expect(store.selectedBusinessId()).toBe('biz-1');
  });
});
