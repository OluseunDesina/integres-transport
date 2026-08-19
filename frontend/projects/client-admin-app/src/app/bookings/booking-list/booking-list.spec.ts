import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { BookingList } from './booking-list';

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'booking-1',
    business: 'biz-1',
    trip: {
      id: 'trip-1',
      route: { id: 'route-1', name: 'Ikeja → CMS' },
      scheduled_departure_at: '2026-09-01T06:30:00Z',
      service_date: '2026-09-01',
    },
    passenger: 'user-1',
    status: 'pending_payment',
    total_amount: '1500.00',
    currency: 'NGN',
    cancellation_reason: '',
    seats: [
      { id: 'r1', seat: '1A', from_stop: 'Ikeja', to_stop: 'CMS', status: 'held', held_until: '' },
      { id: 'r2', seat: '1B', from_stop: 'Ikeja', to_stop: 'CMS', status: 'held', held_until: '' },
    ],
    created_at: '2026-08-10T09:00:00Z',
    ...overrides,
  };
}

function makeTrip() {
  return {
    id: 'trip-1',
    route: { id: 'route-1', name: 'Ikeja → CMS' },
    service_date: '2026-09-01',
  };
}

describe('BookingList', () => {
  let apiClient: { GET: jasmine.Spy };
  let fixture: ComponentFixture<BookingList>;
  let component: BookingList;

  async function createComponent(): Promise<void> {
    fixture = TestBed.createComponent(BookingList);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    apiClient = {
      GET: jasmine.createSpy('GET').and.callFake((path: string) =>
        Promise.resolve(
          path === '/api/v1/trips/'
            ? { data: { count: 1, results: [makeTrip()] } }
            : { data: { count: 1, results: [makeBooking()] } }
        )
      ),
    };

    TestBed.configureTestingModule({
      imports: [BookingList],
      providers: [provideRouter([]), { provide: API_CLIENT, useValue: apiClient }],
    });
  });

  it('loads bookings on init', async () => {
    await createComponent();

    expect(apiClient.GET).toHaveBeenCalledWith('/api/v1/bookings/', jasmine.anything());
    expect(component['store'].items().length).toBe(1);
  });

  it('renders the nested trip fields and seat numbers', async () => {
    await createComponent();

    const cells = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr td')
    ).map((td) => td.textContent?.trim());
    expect(cells[0]).toBe('Ikeja → CMS');
    expect(cells[1]).toBe('2026-09-01');
    expect(cells[3]).toBe('1A, 1B');
    expect(cells[4]).toBe('NGN 1500.00');
  });

  // `booking.manage` does not exist this phase: cancelling is the
  // passenger's own action, so any action affordance here would be one
  // the server refuses.
  it('offers no cancel or edit affordance', async () => {
    await createComponent();

    const host = fixture.nativeElement as HTMLElement;
    // Nothing interactive in the body at all, and no actions column to
    // put it in. Asserting on the absence of the word "Cancel" would
    // be wrong here: `Cancelled` is a legitimate status label.
    expect(host.querySelectorAll('tbody button, tbody a, tbody input').length).toBe(0);
    expect(host.querySelector('thead')?.textContent).not.toContain('Actions');
  });

  // A column of passenger UUIDs helps nobody; nesting an email is a
  // backend change this slice does not depend on.
  it('does not render the raw passenger uuid', async () => {
    await createComponent();

    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('user-1');
  });

  it('builds trip filter options from the trips endpoint', async () => {
    await createComponent();

    expect(component['tripFilterOptions']()).toEqual([
      { value: '', label: 'All trips' },
      { value: 'trip-1', label: 'Ikeja → CMS — 2026-09-01' },
    ]);
  });

  it('refetches with the trip filter applied', async () => {
    await createComponent();

    component['onTripFilterChange']('trip-1');
    await fixture.whenStable();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/bookings/',
      jasmine.objectContaining({
        params: { query: { limit: 25, offset: 0, trip: 'trip-1', status: undefined } },
      })
    );
  });

  it('clears a filter back to undefined rather than an empty string', async () => {
    await createComponent();

    component['onStatusFilterChange']('');
    await fixture.whenStable();

    expect(component['store'].query().status).toBeUndefined();
  });

  it('shows an empty state when nothing has been booked', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await createComponent();

    expect((fixture.nativeElement as HTMLElement).querySelector('ui-empty-state')).toBeTruthy();
  });
});
