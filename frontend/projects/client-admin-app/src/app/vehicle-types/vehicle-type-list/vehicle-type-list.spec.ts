import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { VehicleTypeList } from './vehicle-type-list';
import { BusinessStore, type Business } from '../../shared/data/store/business.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { VehicleTypeStore, type VehicleType } from '../../shared/data/store/vehicle-type.store';

function makeUser(overrides: Partial<AuthUser>): AuthUser {
  return {
    id: 'user-1',
    email: 'owner@example.com',
    firstName: '',
    lastName: '',
    client: 'client-1',
    isPlatformStaff: false,
    isClientStaff: true,
    permissions: [],
    roleName: null,
    clientName: null,
    ...overrides,
  };
}

function makeVehicleType(overrides: Partial<VehicleType> = {}): VehicleType {
  return {
    id: 'vt-1',
    business: 'biz-1',
    name: '33-seater coaster',
    capacity: 33,
    is_active: true,
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

class FakeVehicleTypeStore {
  items = signal<VehicleType[]>([]);
  total = signal(0);
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  updateQuery = jasmine.createSpy('updateQuery').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

class FakeBusinessStore {
  items = signal<Business[]>([]);
  total = signal(0);
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

class FakeSelectedBusinessStore {
  selectedBusinessId = signal<string | null>('biz-1');
}

describe('VehicleTypeList', () => {
  let fixture: ComponentFixture<VehicleTypeList>;
  let store: FakeVehicleTypeStore;
  let authStore: AuthStore;

  beforeEach(async () => {
    localStorage.clear();
    store = new FakeVehicleTypeStore();

    await TestBed.configureTestingModule({
      imports: [VehicleTypeList],
      providers: [
        provideRouter([]),
        { provide: VehicleTypeStore, useValue: store },
        { provide: BusinessStore, useValue: new FakeBusinessStore() },
        { provide: SelectedBusinessStore, useValue: new FakeSelectedBusinessStore() },
      ],
    }).compileComponents();

    authStore = TestBed.inject(AuthStore);
    authStore.setSession(
      'a',
      'r',
      makeUser({ permissions: ['client-admin:access', 'fleet.view', 'seating.view'] })
    );

    fixture = TestBed.createComponent(VehicleTypeList);
    fixture.detectChanges();
  });

  afterEach(() => localStorage.clear());

  it('scopes the query to the active Business on init', () => {
    expect(store.updateQuery).toHaveBeenCalledWith({ business: 'biz-1' });
  });

  it('shows the empty state when the store has no rows', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No vehicle types yet');
  });

  it('renders a row per vehicle type', () => {
    store.items.set([makeVehicleType(), makeVehicleType({ id: 'vt-2', name: 'Sprinter van' })]);
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0].nativeElement.textContent).toContain('33-seater coaster');
  });

  it('shows a "Seat map" link with seating.view permission', () => {
    store.items.set([makeVehicleType()]);
    fixture.detectChanges();

    const links = fixture.debugElement
      .queryAll(By.css('a'))
      .map((el) => (el.nativeElement.textContent as string).trim());
    expect(links).toContain('Seat map');
  });

  it('hides the "Seat map" link without seating.view permission', () => {
    authStore.setSession('a', 'r', makeUser({ permissions: ['client-admin:access'] }));
    store.items.set([makeVehicleType()]);
    fixture.detectChanges();

    const links = fixture.debugElement
      .queryAll(By.css('a'))
      .map((el) => (el.nativeElement.textContent as string).trim());
    expect(links).not.toContain('Seat map');
  });

  it('hides the "New vehicle type" button without fleet.manage permission', () => {
    const buttons = fixture.debugElement
      .queryAll(By.css('button'))
      .map((el) => (el.nativeElement.textContent as string).trim());
    expect(buttons).not.toContain('New vehicle type');
  });

  it('shows the "New vehicle type" button with fleet.manage permission', () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({ permissions: ['client-admin:access', 'fleet.view', 'fleet.manage'] })
    );
    fixture.detectChanges();

    const buttons = fixture.debugElement
      .queryAll(By.css('button'))
      .map((el) => (el.nativeElement.textContent as string).trim());
    expect(buttons).toContain('New vehicle type');
  });

  it('navigates to /vehicle-types/new when "New vehicle type" is pressed', async () => {
    authStore.setSession(
      'a',
      'r',
      makeUser({ permissions: ['client-admin:access', 'fleet.view', 'fleet.manage'] })
    );
    fixture.detectChanges();
    const router = TestBed.inject(Router);
    const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

    const button = fixture.debugElement
      .queryAll(By.css('button'))
      .find((el) => (el.nativeElement.textContent as string).trim() === 'New vehicle type');
    button?.nativeElement.click();
    await fixture.whenStable();

    expect(navigateSpy).toHaveBeenCalledWith(['/vehicle-types/new']);
  });
});
