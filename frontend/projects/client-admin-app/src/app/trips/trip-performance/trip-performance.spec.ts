import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter } from '@angular/router';

import { TripPerformance } from './trip-performance';
import {
  TripPerformanceStore,
  type TripPerformance as Performance,
} from '../../shared/data/store/trip-performance.store';

function makePerformance(overrides: Partial<Performance> = {}): Performance {
  return {
    trip: {
      id: 'trip-1',
      route: 'Ikeja → CMS',
      trip_class: 'premium',
      status: 'completed',
      booking_mode: 'reservation',
      service_date: '2026-08-20',
    },
    capacity: { total_seats: 44, seats_sold: 39, occupancy_rate: '0.886' },
    punctuality: {
      scheduled_departure_at: '2026-08-20T06:30:00Z',
      actual_departure_at: '2026-08-20T06:42:00Z',
      actual_arrival_at: null,
      delay_minutes: 12,
      on_time: false,
    },
    money: [
      {
        currency: 'NGN',
        revenue: '42120.00',
        gross: '44000.00',
        revenue_per_seat: '1080.00',
      },
    ],
    incidents: 0,
    cancelled: false,
    ...overrides,
  };
}

class FakeStore {
  data = signal<Performance | null>(makePerformance());
  loading = signal(false);
  error = signal<string | null>(null);
  notFound = signal(false);
  load = jasmine.createSpy('load').and.resolveTo();
}

describe('TripPerformance', () => {
  let fixture: ComponentFixture<TripPerformance>;
  let store: FakeStore;

  function setup(): void {
    fixture = TestBed.createComponent(TripPerformance);
    fixture.detectChanges();
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  beforeEach(() => {
    store = new FakeStore();
    TestBed.configureTestingModule({
      imports: [TripPerformance],
      providers: [
        provideRouter([]),
        { provide: TripPerformanceStore, useValue: store },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: { get: () => 'trip-1' } } },
        },
      ],
    });
  });

  it('loads the trip named in the route', () => {
    setup();
    expect(store.load).toHaveBeenCalledWith('trip-1');
  });

  it('renders capacity, punctuality and money', () => {
    setup();

    expect(text()).toContain('89%');
    expect(text()).toContain('12 min late');
    expect(text()).toContain('NGN 42120.00');
    expect(text()).toContain('NGN 1080.00');
  });

  describe('the nulls, which are the whole design', () => {
    it('says occupancy is not available without a vehicle, never 0%', () => {
      // 0% would read as "nobody bought a seat" on a departure nobody
      // has assigned a bus to.
      store.data.set(
        makePerformance({
          capacity: { total_seats: null, seats_sold: 3, occupancy_rate: null },
        })
      );
      setup();

      expect(text()).toContain('Not available');
      expect(text()).not.toContain('0%');
      expect(text()).toContain('No vehicle assigned');
    });

    it('draws no doughnut when there is no denominator', () => {
      // A ring from one slice would read as "100% full" on a trip whose
      // capacity is simply not known.
      store.data.set(
        makePerformance({
          capacity: { total_seats: null, seats_sold: 3, occupancy_rate: null },
        })
      );
      setup();

      const chart = fixture.debugElement.query(By.css('ui-chart'));
      expect(chart.nativeElement.textContent).toContain('No capacity is known');
    });

    it('says a trip has not departed rather than showing it as on time', () => {
      store.data.set(makePerformance({ punctuality: null }));
      setup();

      expect(text()).toContain('Not departed yet');
      expect(text()).not.toContain('0 min');
    });

    it('renders revenue per seat as not available with nothing sold', () => {
      store.data.set(
        makePerformance({
          money: [
            { currency: 'NGN', revenue: '0.00', gross: '0.00', revenue_per_seat: null },
          ],
        })
      );
      setup();

      expect(text()).toContain('Not available');
    });

    it('suppresses occupancy for a cancelled trip, so it drags no average', () => {
      store.data.set(
        makePerformance({
          cancelled: true,
          capacity: { total_seats: 44, seats_sold: 10, occupancy_rate: null },
        })
      );
      setup();

      expect(text()).toContain('Suppressed for a cancelled trip');
    });
  });

  it('renders an accessible data table beside the occupancy chart', () => {
    setup();
    const chart = fixture.debugElement.query(By.css('ui-chart'));
    expect(chart.query(By.css('table.sr-only'))).not.toBeNull();
  });

  describe('failure states', () => {
    it('distinguishes a missing trip from a broken request', () => {
      // A bookmark to a deleted trip is an ordinary thing to happen and
      // reads very differently from "the server broke".
      store.notFound.set(true);
      store.data.set(null);
      setup();

      expect(text()).toContain('Trip not found');
      expect(fixture.debugElement.query(By.css('ui-alert'))).toBeNull();
    });

    it('renders a real failure as an alert', () => {
      store.error.set('Something went wrong.');
      store.data.set(null);
      setup();

      expect(fixture.debugElement.query(By.css('ui-alert'))).not.toBeNull();
    });
  });
});
