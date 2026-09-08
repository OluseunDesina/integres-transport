import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { IncidentReportStore } from './incident-report.store';

function makeReport(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inc-1',
    reference: 'INC-AB12CD',
    title: 'Card reader would not take my card',
    description: 'No lights at all.',
    category: 'hardware',
    status: 'open',
    created_at: '2026-09-01T07:00:00Z',
    resolved_at: null,
    ...overrides,
  };
}

describe('IncidentReportStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: IncidentReportStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };

    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });

    store = TestBed.inject(IncidentReportStore);
  });

  it('reads the reporter-scoped endpoint, with no filter of its own', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeReport()] } });

    await store.getAll();

    // Nothing but pagination: server-side scoping to `request.user` is
    // the entire filter, the same reason `BookingStore` carries no
    // query either.
    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/incidents/mine/',
      jasmine.objectContaining({ params: { query: { limit: 25, offset: 0 } } })
    );
    expect(store.items()[0].reference).toBe('INC-AB12CD');
    expect(store.total()).toBe(1);
  });

  it('surfaces the server message on failure', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Authentication credentials were not provided.' } });

    await store.getAll();

    expect(store.error()).toBe('Authentication credentials were not provided.');
    expect(store.items()).toEqual([]);
  });

  it('falls back to its own wording when the body carries no detail', async () => {
    apiClient.GET.and.resolveTo({ error: {} });

    await store.getAll();

    expect(store.error()).toBe('Failed to load your reports.');
  });

  it('pages without losing the endpoint', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 40, results: [makeReport()] } });
    await store.getAll();

    await store.changePage(25);

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/incidents/mine/',
      jasmine.objectContaining({ params: { query: { limit: 25, offset: 25 } } })
    );
  });
});
