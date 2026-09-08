import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { IncidentDetail } from './incident-detail';
import { IncidentStore } from '../../shared/data/store/incident.store';

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

function makeDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inc-1',
    reference: 'INC-AB12CD',
    business: 'biz-1',
    title: 'Validator on bus 12 is dead',
    description: 'No lights at all.',
    category: 'hardware',
    severity: 'critical',
    status: 'open',
    source: 'passenger',
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
    reported_by: 'user-2',
    reported_by_email: 'rider@example.com',
    assigned_to: null,
    assigned_to_email: null,
    latitude: null,
    longitude: null,
    resolved_at: null,
    resolution_notes: '',
    created_at: '2026-09-06T08:00:00Z',
    updated_at: '2026-09-06T08:00:00Z',
    activities: [],
    ...overrides,
  };
}

class FakeIncidentStore {
  detail: unknown = makeDetail();
  users: unknown[] = [{ id: 'u1', email: 'tech@example.com', first_name: '', last_name: '' }];
  findDetail = jasmine.createSpy('findDetail').and.callFake(() => Promise.resolve(this.detail));
  assignableUsers = jasmine
    .createSpy('assignableUsers')
    .and.callFake(() => Promise.resolve(this.users));
}

describe('IncidentDetail', () => {
  let fixture: ComponentFixture<IncidentDetail>;
  let store: FakeIncidentStore;
  let api: { GET: jasmine.Spy; POST: jasmine.Spy; PATCH: jasmine.Spy };

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  async function setup(user: AuthUser = makeUser()): Promise<void> {
    store = new FakeIncidentStore();
    api = {
      GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 0, results: [] } }),
      POST: jasmine.createSpy('POST').and.resolveTo({ data: makeDetail() }),
      PATCH: jasmine.createSpy('PATCH').and.resolveTo({ data: makeDetail() }),
    };

    await TestBed.configureTestingModule({
      imports: [IncidentDetail],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: api },
        { provide: IncidentStore, useValue: store },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'inc-1' }) } },
        },
      ],
    }).compileComponents();

    TestBed.inject(AuthStore).setSession('a', 'r', user);
    fixture = TestBed.createComponent(IncidentDetail);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('reads the single-record endpoint, which is the only source of the trail', async () => {
    await setup();

    expect(store.findDetail).toHaveBeenCalledWith('inc-1');
    expect(text()).toContain('INC-AB12CD');
    expect(text()).toContain('Critical severity');
  });

  it('renders every unknown relation as "Not recorded", never blank', async () => {
    await setup();

    // A passenger reporting a broken reader on a platform may know none
    // of these, and an empty cell reads as an empty value rather than an
    // unknown one.
    expect(text()).toContain('Not recorded');
    expect(text()).toContain('Nobody yet');
    expect(text()).toContain('Not yet');
  });

  it('offers only the legal next steps', async () => {
    await setup();

    const labels = fixture.componentInstance['transitionOptions']().map((o) => o.label);
    expect(labels).toContain('Acknowledge');
    expect(labels).toContain('Resolve');
    expect(labels).not.toContain('Close');
  });

  it('renders a status change as a readable arrow, not two raw enums', async () => {
    await setup();

    const label = fixture.componentInstance['activityLabel']({
      id: 'a1',
      kind: 'status_change',
      actor: null,
      actor_email: null,
      from_status: 'open',
      to_status: 'acknowledged',
      note: '',
      created_at: '2026-09-06T09:00:00Z',
    } as never);

    expect(label).toBe('Open → Acknowledged');
  });

  it('shows the history once it exists', async () => {
    await setup();
    store.detail = makeDetail({
      activities: [
        {
          id: 'a1',
          kind: 'status_change',
          actor: 'user-1',
          actor_email: 'owner@example.com',
          from_status: 'open',
          to_status: 'acknowledged',
          note: 'Seen by ops.',
          created_at: '2026-09-06T09:00:00Z',
        },
      ],
    });
    fixture.componentInstance['activities'].set(
      (store.detail as { activities: never[] }).activities
    );
    fixture.detectChanges();

    expect(text()).toContain('Open → Acknowledged');
    expect(text()).toContain('Seen by ops.');
  });

  it('surfaces a refused transition rather than silently doing nothing', async () => {
    await setup();
    api.POST.and.resolveTo({
      error: { detail: 'An incident that is closed cannot move to open.' },
    });
    fixture.componentInstance['transitionTo'].set('acknowledged');

    await fixture.componentInstance['onTransition']();
    fixture.detectChanges();

    expect(text()).toContain('cannot move to open');
  });

  it('populates the assignee picker from the incidents endpoint', async () => {
    await setup();

    // Not `/staff/`, which is gated on an Owner-only codename and would
    // 403 for the Manager and Staff users who triage incidents.
    expect(store.assignableUsers).toHaveBeenCalled();
    expect(fixture.componentInstance['assigneeOptions']().map((o) => o.label)).toContain(
      'tech@example.com'
    );
  });

  it('unassigns with an explicit null rather than an empty string', async () => {
    await setup();

    await fixture.componentInstance['onAssign']('');

    expect(api.PATCH).toHaveBeenCalledWith(
      '/api/v1/incidents/{id}/',
      jasmine.objectContaining({ body: { assigned_to: null } })
    );
  });

  it('hides every lifecycle control from a view-only user', async () => {
    await setup(makeUser({ permissions: ['client-admin:access', 'incidents.view'] }));

    // They still see the whole record and its history — that is the
    // point of splitting view from manage.
    expect(text()).toContain('INC-AB12CD');
    expect(text()).not.toContain('Status and assignment');
    expect(text()).not.toContain('Add an internal note');
  });

  it('says so when the incident does not exist', async () => {
    store = new FakeIncidentStore();
    await setup();
    fixture.componentInstance['notFound'].set(true);
    fixture.componentInstance['incident'].set(null);
    fixture.detectChanges();

    expect(text()).toContain('Incident not found');
  });
});
