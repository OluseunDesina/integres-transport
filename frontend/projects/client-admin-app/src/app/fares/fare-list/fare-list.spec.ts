import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { FareList } from './fare-list';
import { FareRuleStore, type FareRule } from '../../shared/data/store/fare-rule.store';
import {
  FareSegmentRuleStore,
  type FareSegmentRule,
} from '../../shared/data/store/fare-segment-rule.store';
import { RouteStore, type Route } from '../../shared/data/store/route.store';
import { SelectedBusinessStore, type Business } from '../../shared/data/store/selected-business.store';
import { StopStore, type Stop } from '../../shared/data/store/stop.store';

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

function makeBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: 'biz-1',
    vertical: 'shuttle',
    name: 'Acme Shuttle Co',
    currency: 'NGN',
    timezone: 'Africa/Lagos',
    booking_mode_default: 'reservation',
    fare_pricing_mode: 'flat',
    is_active: true,
    kyb_status: 'approved',
    kyb_submitted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeFareRule(overrides: Partial<FareRule> = {}): FareRule {
  return {
    id: 'fare-1',
    business: 'biz-1',
    route: 'route-1',
    amount: '500.00',
    effective_from: '2026-01-01T00:00:00Z',
    effective_to: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeFareSegmentRule(overrides: Partial<FareSegmentRule> = {}): FareSegmentRule {
  return {
    id: 'fare-seg-1',
    business: 'biz-1',
    route: 'route-1',
    from_stop: 'stop-1',
    to_stop: 'stop-2',
    amount: '300.00',
    effective_from: '2026-01-01T00:00:00Z',
    effective_to: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

class FakeListStore<T> {
  items = signal<T[]>([]);
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
  items = signal<Business[]>([makeBusiness()]);
  selectedBusinessId = signal<string | null>('biz-1');
}

async function setup(businesses: Business[]) {
  const fareRuleStore = new FakeListStore<FareRule>();
  const fareSegmentRuleStore = new FakeListStore<FareSegmentRule>();
  const routeStore = new FakeListStore<Route>();
  const stopStore = new FakeListStore<Stop>();
  const selectedBusinessStore = new FakeSelectedBusinessStore();
  selectedBusinessStore.items.set(businesses);

  await TestBed.configureTestingModule({
    imports: [FareList],
    providers: [
      provideRouter([]),
      { provide: FareRuleStore, useValue: fareRuleStore },
      { provide: FareSegmentRuleStore, useValue: fareSegmentRuleStore },
      { provide: RouteStore, useValue: routeStore },
      { provide: StopStore, useValue: stopStore },
      { provide: SelectedBusinessStore, useValue: selectedBusinessStore },
    ],
  }).compileComponents();

  const authStore = TestBed.inject(AuthStore);
  authStore.setSession('a', 'r', makeUser({ permissions: ['client-admin:access', 'fares.view'] }));

  const fixture = TestBed.createComponent(FareList);
  return { fixture, fareRuleStore, fareSegmentRuleStore, routeStore, stopStore };
}

describe('FareList', () => {
  afterEach(() => localStorage.clear());

  describe('a flat-pricing Business', () => {
    let fixture: ComponentFixture<FareList>;
    let fareRuleStore: FakeListStore<FareRule>;
    let routeStore: FakeListStore<Route>;

    beforeEach(async () => {
      ({ fixture, fareRuleStore, routeStore } = await setup([makeBusiness({ fare_pricing_mode: 'flat' })]));
      fixture.detectChanges();
    });

    it('scopes the FareRule query to the active Business on init', () => {
      expect(fareRuleStore.updateQuery).toHaveBeenCalledWith({ business: 'biz-1' });
    });

    it('shows the flat-fare empty state when there are no rows', () => {
      fareRuleStore.isEmpty.set(true);
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain('flat fare');
    });

    it('renders a flat fare row with its route name', () => {
      routeStore.items.set([{ id: 'route-1', business: 'biz-1', name: 'Ikeja Express' } as Route]);
      fareRuleStore.items.set([makeFareRule()]);
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain('Ikeja Express');
      expect(fixture.nativeElement.textContent).toContain('500.00');
    });
  });

  describe('a per-segment-pricing Business', () => {
    let fixture: ComponentFixture<FareList>;
    let fareSegmentRuleStore: FakeListStore<FareSegmentRule>;
    let routeStore: FakeListStore<Route>;
    let stopStore: FakeListStore<Stop>;

    beforeEach(async () => {
      ({ fixture, fareSegmentRuleStore, routeStore, stopStore } = await setup([
        makeBusiness({ fare_pricing_mode: 'per_segment' }),
      ]));
      fixture.detectChanges();
    });

    it('scopes the FareSegmentRule query to the active Business on init', () => {
      expect(fareSegmentRuleStore.updateQuery).toHaveBeenCalledWith({ business: 'biz-1' });
    });

    it('renders a per-segment fare row with its stop names', () => {
      routeStore.items.set([{ id: 'route-1', business: 'biz-1', name: 'Ikeja Express' } as Route]);
      stopStore.items.set([
        { id: 'stop-1', name: 'Ikeja Bus Stop' } as Stop,
        { id: 'stop-2', name: 'Lekki Toll Gate' } as Stop,
      ]);
      fareSegmentRuleStore.items.set([makeFareSegmentRule()]);
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain('Ikeja Bus Stop');
      expect(fixture.nativeElement.textContent).toContain('Lekki Toll Gate');
    });
  });
});
