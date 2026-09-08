import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { IncidentStore } from './incident.store';

function makeIncident(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inc-1',
    reference: 'INC-AB12CD',
    business: 'biz-1',
    title: 'Validator on bus 12 is dead',
    description: 'Card reader shows no lights.',
    category: 'hardware',
    severity: 'high',
    status: 'open',
    source: 'operator',
    trip: null,
    route: null,
    route_name: null,
    vehicle: null,
    vehicle_registration: null,
    driver: null,
    driver_name: null,
    stop: null,
    stop_name: null,
    device_reference: '',
    reported_by: 'user-1',
    reported_by_email: 'staff@example.com',
    assigned_to: null,
    assigned_to_email: null,
    latitude: null,
    longitude: null,
    resolved_at: null,
    resolution_notes: '',
    created_at: '2026-09-06T08:00:00Z',
    updated_at: '2026-09-06T08:00:00Z',
    ...overrides,
  };
}

describe('IncidentStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: IncidentStore;

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };
    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });
    store = TestBed.inject(IncidentStore);
  });

  it('maps a {count,results} envelope to {items,total}', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeIncident()] } });

    await store.getAll();

    expect(store.items().length).toBe(1);
    expect(store.total()).toBe(1);
    expect(store.items()[0].reference).toBe('INC-AB12CD');
  });

  it('starts scoped to open incidents only', async () => {
    // Seeded, not hidden — the list screen renders this as a removable
    // chip. A queue defaulting to "everything ever reported" becomes
    // unusable within a month of real use.
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await store.getAll();

    const query = apiClient.GET.calls.mostRecent().args[1].params.query;
    expect(query.open_only).toBe('true');
  });

  it('omits open_only entirely once it is cleared', async () => {
    // `open_only=false` would be a *filter* on the server, not an
    // absence of one. The param has to disappear.
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await store.updateQuery({ open_only: false });

    const query = apiClient.GET.calls.mostRecent().args[1].params.query;
    expect(query.open_only).toBeUndefined();
  });

  it('passes every filter dimension through to the API', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await store.updateQuery({
      business: 'biz-1',
      status: 'acknowledged',
      severity: 'critical',
      category: 'safety',
      source: 'passenger',
      search: 'reader',
    });

    const query = apiClient.GET.calls.mostRecent().args[1].params.query;
    expect(query).toEqual(
      jasmine.objectContaining({
        business: 'biz-1',
        status: 'acknowledged',
        severity: 'critical',
        category: 'safety',
        source: 'passenger',
        search: 'reader',
      })
    );
  });

  it('surfaces the API detail message rather than a generic failure', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'Unknown business.' } });

    await store.getAll();

    expect(store.error()).toBe('Unknown business.');
  });

  describe('findDetail', () => {
    it('calls the single-record endpoint once, not the paged list', async () => {
      // The deliberate divergence from `findByIdPaged`: this domain has
      // a real detail endpoint, and it is the only source of the trail.
      apiClient.GET.and.resolveTo({
        data: { ...makeIncident(), activities: [] },
      });

      const found = await store.findDetail('inc-1');

      expect(apiClient.GET).toHaveBeenCalledTimes(1);
      expect(apiClient.GET.calls.mostRecent().args[0]).toBe('/api/v1/incidents/{id}/');
      expect(found?.id).toBe('inc-1');
    });

    it('returns null for a missing or another Client’s incident', async () => {
      // The API answers 404 for both, and the screen renders one "not
      // found" either way rather than leaking which it was.
      apiClient.GET.and.resolveTo({ error: { detail: 'Not found.' } });

      expect(await store.findDetail('nope')).toBeNull();
    });

    it('does not disturb the list', async () => {
      apiClient.GET.and.resolveTo({ data: { count: 1, results: [makeIncident()] } });
      await store.getAll();

      apiClient.GET.and.resolveTo({ data: { ...makeIncident({ id: 'inc-9' }), activities: [] } });
      await store.findDetail('inc-9');

      expect(store.items().length).toBe(1);
      expect(store.items()[0].id).toBe('inc-1');
    });
  });

  describe('assignableUsers', () => {
    it('reads the incidents-scoped endpoint, not /staff/', async () => {
      // `/staff/` is gated on `staff.manage`, an Owner-only codename, so
      // it would 403 for exactly the people who triage incidents.
      apiClient.GET.and.resolveTo({
        data: { count: 1, results: [{ id: 'u1', email: 'a@b.c', first_name: '', last_name: '' }] },
      });

      const users = await store.assignableUsers();

      expect(apiClient.GET.calls.mostRecent().args[0]).toBe(
        '/api/v1/incidents/assignable-users/'
      );
      expect(users.length).toBe(1);
    });

    it('returns an empty list rather than throwing when it is refused', async () => {
      apiClient.GET.and.resolveTo({ error: { detail: 'Forbidden.' } });

      expect(await store.assignableUsers()).toEqual([]);
    });
  });
});
