import { Dialog } from '@angular/cdk/dialog';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';
import type { ConfirmDialogData } from '@shared-ui';
import { Subject } from 'rxjs';

import { RouteDetail } from './route-detail';
import { RouteStore, type RouteDetail as Detail } from '../../shared/data/store/route.store';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    email: 'owner@example.com',
    firstName: '',
    lastName: '',
    client: 'client-1',
    isPlatformStaff: false,
    isClientStaff: true,
    permissions: ['client-admin:access', 'network.view', 'network.manage'],
    roleName: null,
    clientName: null,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<Detail> = {}): Detail {
  return {
    id: 'route-1',
    business: 'biz-1',
    name: 'Ikeja Express',
    code: 'IKJ-1',
    description: '',
    status: 'active',
    distance_km: null,
    estimated_duration_minutes: null,
    stops: [],
    created_at: '2026-09-06T08:00:00Z',
    stop_count: 0,
    schedule_count: 0,
    current_fare_summary: { pricing_mode: 'flat', configured: true, rule_count: 1 },
    ...overrides,
  };
}

class FakeRouteStore {
  constructor(public detail: Detail | null) {}
  findDetail = jasmine.createSpy('findDetail').and.callFake(() => Promise.resolve(this.detail));
}

describe('RouteDetail', () => {
  let fixture: ComponentFixture<RouteDetail>;
  let store: FakeRouteStore;
  let api: { GET: jasmine.Spy; POST: jasmine.Spy };
  let dialogSpy: jasmine.SpyObj<Dialog>;
  let closedSubject: Subject<boolean | undefined>;

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  async function setup(
    detail: Detail | null = makeDetail(),
    user: AuthUser = makeUser()
  ): Promise<void> {
    fixture?.destroy();
    TestBed.resetTestingModule();

    store = new FakeRouteStore(detail);
    api = {
      GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 0, results: [] } }),
      POST: jasmine.createSpy('POST').and.resolveTo({ data: {} }),
    };
    closedSubject = new Subject<boolean | undefined>();
    dialogSpy = jasmine.createSpyObj<Dialog>('Dialog', ['open']);
    dialogSpy.open.and.returnValue({
      closed: closedSubject.asObservable(),
    } as ReturnType<Dialog['open']>);

    await TestBed.configureTestingModule({
      imports: [RouteDetail],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: api },
        { provide: RouteStore, useValue: store },
        { provide: Dialog, useValue: dialogSpy },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'route-1' }) } },
        },
      ],
    }).compileComponents();

    TestBed.inject(AuthStore).setSession('a', 'r', user);

    fixture = TestBed.createComponent(RouteDetail);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  afterEach(() => {
    fixture?.destroy();
  });

  it('shows a skeleton before the first answer', async () => {
    fixture?.destroy();
    TestBed.resetTestingModule();
    store = new FakeRouteStore(makeDetail());
    await TestBed.configureTestingModule({
      imports: [RouteDetail],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: { GET: jasmine.createSpy('GET') } },
        { provide: RouteStore, useValue: store },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'route-1' }) } },
        },
      ],
    }).compileComponents();
    TestBed.inject(AuthStore).setSession('a', 'r', makeUser());
    fixture = TestBed.createComponent(RouteDetail);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('ui-skeleton')).not.toBeNull();
    expect(text()).not.toContain('Ikeja Express');
  });

  it('distinguishes a deleted route from a failure', async () => {
    await setup(null);

    expect(text()).toContain('Route not found');
  });

  it('renders the name, status, code and creation date', async () => {
    await setup();

    expect(text()).toContain('Ikeja Express');
    expect(text()).toContain('Active');
    expect(text()).toContain('IKJ-1');
  });

  it('says "—" for distance and duration when neither is set', async () => {
    await setup();

    expect(text()).toContain('—');
  });

  it('renders distance and duration when set', async () => {
    await setup(makeDetail({ distance_km: '12.50', estimated_duration_minutes: 45 }));

    expect(text()).toContain('12.50 km');
    expect(text()).toContain('45 min');
  });

  it('says no stops are ordered yet when there are none', async () => {
    await setup(makeDetail({ stop_count: 0, stops: [] }));

    expect(text()).toContain('No stops ordered yet');
  });

  it('lists ordered stops by name', async () => {
    await setup(
      makeDetail({
        stop_count: 2,
        stops: [
          { id: 's1', name: 'Ikeja', sequence: 1 },
          { id: 's2', name: 'Yaba', sequence: 2 },
        ] as Detail['stops'],
      })
    );

    expect(text()).toContain('Ikeja');
    expect(text()).toContain('Yaba');
    expect(text()).toContain('Stops (2)');
  });

  it('reports an unconfigured fare as a reason activation is blocked', async () => {
    await setup(
      makeDetail({
        current_fare_summary: { pricing_mode: 'flat', configured: false, rule_count: 0 },
      })
    );

    expect(text()).toContain('No currently-effective fare');
    expect(text()).toContain('cannot be activated');
  });

  it('reports a configured fare with its rule count', async () => {
    await setup(
      makeDetail({
        current_fare_summary: { pricing_mode: 'per_segment', configured: true, rule_count: 3 },
      })
    );

    expect(text()).toContain('3');
    expect(text()).toContain('segment fare rules');
  });

  // --- Status actions and permission gating ---

  it('offers Deactivate and Archive for an active route', async () => {
    await setup();

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('ui-button')).map((el) =>
      (el as HTMLElement).textContent?.trim()
    );
    expect(buttons).toContain('Deactivate');
    expect(buttons).toContain('Archive');
    expect(buttons).toContain('Duplicate');
  });

  it('offers only Restore for an archived route, alongside Duplicate', async () => {
    await setup(makeDetail({ status: 'archived' }));

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('ui-button')).map((el) =>
      (el as HTMLElement).textContent?.trim()
    );
    expect(buttons).toEqual(['Restore', 'Duplicate']);
  });

  it('hides the status-and-actions section from a view-only user', async () => {
    await setup(makeDetail(), makeUser({ permissions: ['client-admin:access', 'network.view'] }));

    expect(text()).not.toContain('Status and actions');
    expect(fixture.nativeElement.querySelector('ui-button')).toBeNull();
  });

  it('confirms before deactivating, styled as destructive', async () => {
    await setup();
    fixture.componentInstance['confirmStatusChange']('inactive');

    expect(dialogSpy.open).toHaveBeenCalled();
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.title).toBe('Deactivate Ikeja Express?');
    expect(data.danger()).toBeTrue();
  });

  it('does not treat restoring as destructive', async () => {
    await setup(makeDetail({ status: 'archived' }));
    fixture.componentInstance['confirmStatusChange']('inactive');

    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.title).toBe('Restore Ikeja Express?');
    expect(data.danger()).toBeFalse();
  });

  it('posts the transition and reloads once the dialog confirms', async () => {
    await setup();
    fixture.componentInstance['confirmStatusChange']('archived');
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;

    expect(await data.onConfirm()).toEqual({ ok: true });
    expect(api.POST).toHaveBeenCalledWith('/api/v1/routes/{id}/status/', {
      params: { path: { id: 'route-1' } },
      body: { status: 'archived' },
    });

    store.detail = makeDetail({ status: 'archived' });
    closedSubject.next(true);
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();

    expect(store.findDetail).toHaveBeenCalledTimes(2);
  });

  it('surfaces a rejected transition inside the dialog', async () => {
    await setup();
    api.POST.and.resolveTo({ error: { detail: '2 future trip(s) are scheduled.' } });
    fixture.componentInstance['confirmStatusChange']('archived');
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;

    expect(await data.onConfirm()).toEqual({
      ok: false,
      error: '2 future trip(s) are scheduled.',
    });
  });

  it('confirms before duplicating, not styled as destructive, and navigates to the copy', async () => {
    await setup();
    const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    api.POST.and.resolveTo({ data: { id: 'route-2' } });

    fixture.componentInstance['confirmDuplicate']();
    const data = dialogSpy.open.calls.mostRecent().args[1]?.data as ConfirmDialogData;
    expect(data.title).toBe('Duplicate Ikeja Express?');
    expect(data.danger()).toBeFalse();

    expect(await data.onConfirm()).toEqual({ ok: true });
    expect(api.POST).toHaveBeenCalledWith('/api/v1/routes/{id}/duplicate/', {
      params: { path: { id: 'route-1' } },
    });

    closedSubject.next(true);
    await new Promise((resolve) => setTimeout(resolve));

    expect(navigate).toHaveBeenCalledWith(['/routes', 'route-2', 'edit']);
  });
});
