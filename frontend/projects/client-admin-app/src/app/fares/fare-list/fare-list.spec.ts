import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { expectColumnVisibilityParity } from '@shared-ui';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { FareList } from './fare-list';
import { FareRuleStore, type FareRule } from '../../shared/data/store/fare-rule.store';
import {
  FareSegmentRuleStore,
  type FareSegmentRule,
} from '../../shared/data/store/fare-segment-rule.store';
import { RouteStore, type Route } from '../../shared/data/store/route.store';
import {
  SelectedBusinessStore,
  type Business,
} from '../../shared/data/store/selected-business.store';
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
    route_name: 'Ikeja Express',
    // '' is the wildcard class — what every fare rule created before
    // spec 15 backfilled to, so this fixture keeps describing the rules
    // this screen has always listed.
    trip_class: '',
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
    route_name: 'Ikeja Express',
    from_stop: 'stop-1',
    from_stop_name: 'Yaba',
    to_stop: 'stop-2',
    to_stop_name: 'Lekki',
    trip_class: '',
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
  return {
    fixture,
    fareRuleStore,
    fareSegmentRuleStore,
    routeStore,
    stopStore,
  };
}

describe('FareList', () => {
  afterEach(() => localStorage.clear());

  describe('a flat-pricing Business', () => {
    let fixture: ComponentFixture<FareList>;
    let fareRuleStore: FakeListStore<FareRule>;
    let routeStore: FakeListStore<Route>;

    beforeEach(async () => {
      ({ fixture, fareRuleStore, routeStore } = await setup([
        makeBusiness({ fare_pricing_mode: 'flat' }),
      ]));
      fixture.detectChanges();
    });

    it('scopes the FareRule query to the active Business on init', () => {
      expect(fareRuleStore.updateQuery).toHaveBeenCalledWith({
        business: 'biz-1',
      });
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

    // --- docs/specs/14, responsive columns ---

    it('keeps every column hidden in the header hidden in its cells', () => {
      fareRuleStore.items.set([makeFareRule()]);
      fixture.detectChanges();

      expectColumnVisibilityParity(fixture.nativeElement, 'fare-list flat rows');
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
      expect(fareSegmentRuleStore.updateQuery).toHaveBeenCalledWith({
        business: 'biz-1',
      });
    });

    it('renders a per-segment fare row with names taken from the row itself', () => {
      // Slice 3b: these used to be resolved through the shared root
      // RouteStore/StopStore, so a fare whose route or stop sat outside
      // their loaded page rendered as a raw UUID — and loading them here
      // clobbered the routes and stops list screens' own state. The
      // serializer nests the names now.
      fareSegmentRuleStore.items.set([
        makeFareSegmentRule({
          from_stop_name: 'Ikeja Bus Stop',
          to_stop_name: 'Lekki Toll Gate',
        }),
      ]);
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain('Ikeja Bus Stop');
      expect(fixture.nativeElement.textContent).toContain('Lekki Toll Gate');
    });

    it('reads no shared route or stop store at all', () => {
      expect(routeStore.getAll).not.toHaveBeenCalled();
      expect(stopStore.getAll).not.toHaveBeenCalled();
    });
  });
});
