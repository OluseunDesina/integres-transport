import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';
import { expectColumnVisibilityParity } from '@shared-ui';

import { IncidentList } from './incident-list';
import { IncidentStore, type Incident } from '../../shared/data/store/incident.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    email: 'owner@example.com',
    firstName: '',
    lastName: '',
    client: 'client-1',
    isPlatformStaff: false,
    isClientStaff: true,
    permissions: ['client-admin:access', 'incidents.view', 'incidents.manage'],
    roleName: null,
    clientName: null,
    ...overrides,
  };
}

function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-1',
    reference: 'INC-AB12CD',
    business: 'biz-1',
    title: 'Validator on bus 12 is dead',
    description: 'No lights.',
    category: 'hardware',
    severity: 'high',
    status: 'open',
    source: 'operator',
    trip: null,
    route: null,
    route_name: 'Ikeja Express',
    vehicle: null,
    vehicle_registration: null,
    driver: null,
    driver_name: null,
    stop: null,
    stop_name: null,
    device_reference: '',
    reported_by: 'user-1',
    reported_by_email: 'owner@example.com',
    assigned_to: null,
    assigned_to_email: null,
    latitude: null,
    longitude: null,
    resolved_at: null,
    resolution_notes: '',
    created_at: '2026-09-06T08:00:00Z',
    updated_at: '2026-09-06T08:00:00Z',
    ...overrides,
  } as Incident;
}

class FakeIncidentStore {
  items = signal<Incident[]>([]);
  total = signal(0);
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  updateQuery = jasmine.createSpy('updateQuery').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

class FakeSelectedBusinessStore {
  selectedBusinessId = signal<string | null>('biz-1');
}

const apiClientStub = {
  GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 0, results: [] } }),
  POST: jasmine.createSpy('POST').and.resolveTo({ data: {} }),
  PATCH: jasmine.createSpy('PATCH').and.resolveTo({ data: {} }),
};

describe('IncidentList', () => {
  let fixture: ComponentFixture<IncidentList>;
  let store: FakeIncidentStore;

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  beforeEach(async () => {
    localStorage.clear();
    apiClientStub.POST.calls.reset();
    store = new FakeIncidentStore();

    await TestBed.configureTestingModule({
      imports: [IncidentList],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: apiClientStub },
        { provide: IncidentStore, useValue: store },
        { provide: SelectedBusinessStore, useValue: new FakeSelectedBusinessStore() },
      ],
    }).compileComponents();

    TestBed.inject(AuthStore).setSession('a', 'r', makeUser());
    fixture = TestBed.createComponent(IncidentList);
    fixture.detectChanges();
  });

  it('opens narrowed to open incidents, and says so on screen', () => {
    // Seeded *and* visible. A queue quietly hiding rows is
    // indistinguishable from a queue with no data.
    expect(store.updateQuery).toHaveBeenCalledWith(
      jasmine.objectContaining({ open_only: true })
    );
    expect(text()).toContain('Open only');
  });

  it('drops the param entirely when the chip is removed', () => {
    store.updateQuery.calls.reset();

    fixture.componentInstance['onChipRemoved']('open_only');

    expect(store.updateQuery).toHaveBeenCalledWith(
      jasmine.objectContaining({ open_only: undefined })
    );
  });

  it('renders a row with its reference, severity and status', () => {
    store.items.set([makeIncident()]);
    fixture.detectChanges();

    expect(text()).toContain('INC-AB12CD');
    expect(text()).toContain('High');
    expect(text()).toContain('Open');
  });

  it('keeps every hidden column consistent across header, cell and skeleton', () => {
    // Both states, because the skeleton row is a separate set of <td>s
    // and missing the class on one shifts every later value under the
    // wrong heading — silently.
    store.items.set([makeIncident()]);
    fixture.detectChanges();
    expectColumnVisibilityParity(fixture.nativeElement, 'incident-list rows');

    store.loading.set(true);
    fixture.detectChanges();
    expectColumnVisibilityParity(fixture.nativeElement, 'incident-list skeleton');
  });

  it('distinguishes an empty result from a load failure', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();
    expect(text()).toContain('No incidents');

    store.error.set('Failed to load incidents.');
    fixture.detectChanges();
    expect(text()).toContain('Failed to load incidents.');
  });

  it('offers only the legal next statuses in the row menu', () => {
    const items = fixture.componentInstance['menuItems'](makeIncident({ status: 'resolved' }));
    const ids = items.map((item) => item.id);

    expect(ids).toContain('transition:closed');
    expect(ids).toContain('transition:investigating');
    expect(ids).not.toContain('transition:open');
  });

  it('calls a reopen a reopen rather than showing the raw status', () => {
    const items = fixture.componentInstance['menuItems'](makeIncident({ status: 'closed' }));

    expect(items.find((item) => item.id === 'transition:investigating')?.label).toBe('Reopen');
  });

  it('transitions from the row and refreshes the queue', async () => {
    store.items.set([makeIncident()]);
    fixture.detectChanges();

    await fixture.componentInstance['onMenuSelected'](
      makeIncident(),
      'transition:acknowledged'
    );
    await fixture.whenStable();

    expect(apiClientStub.POST).toHaveBeenCalledWith(
      '/api/v1/incidents/{id}/transition/',
      jasmine.objectContaining({ body: { status: 'acknowledged' } })
    );
  });

  it('shows a refused transition without hiding the row it came from', async () => {
    apiClientStub.POST.and.resolveTo({
      error: { detail: 'An incident that is closed cannot move to open.' },
    });
    store.items.set([makeIncident({ status: 'closed' })]);
    fixture.detectChanges();

    fixture.componentInstance['onMenuSelected'](makeIncident(), 'transition:open');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(text()).toContain('cannot move to open');
    // The table is still there — a transient failure must not replace it.
    expect(text()).toContain('INC-AB12CD');
    apiClientStub.POST.and.resolveTo({ data: {} });
  });

  it('hides every management action from a view-only user', () => {
    TestBed.inject(AuthStore).setSession(
      'a',
      'r',
      makeUser({ permissions: ['client-admin:access', 'incidents.view'] })
    );
    store.items.set([makeIncident()]);
    fixture.detectChanges();

    const items = fixture.componentInstance['menuItems'](makeIncident());
    expect(items.map((item) => item.id)).toEqual(['view']);
    expect(text()).not.toContain('Report an incident');
  });
});
