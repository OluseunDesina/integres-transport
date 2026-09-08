import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { expectColumnVisibilityParity } from '@shared-ui';

import { BookingList } from './booking-list';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

class FakeSelectedBusinessStore {
  selectedBusinessId = signal<string | null>('biz-1');
}

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
      {
        id: 'r1',
        seat: '1A',
        from_stop: 'Ikeja',
        to_stop: 'CMS',
        status: 'held',
        held_until: '',
      },
      {
        id: 'r2',
        seat: '1B',
        from_stop: 'Ikeja',
        to_stop: 'CMS',
        status: 'held',
        held_until: '',
      },
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
      GET: jasmine
        .createSpy('GET')
        .and.callFake((path: string) =>
          Promise.resolve(
            path === '/api/v1/trips/'
              ? { data: { count: 1, results: [makeTrip()] } }
              : { data: { count: 1, results: [makeBooking()] } }
          )
        ),
    };

    TestBed.configureTestingModule({
      imports: [BookingList],
      providers: [
        provideRouter([]),
        { provide: API_CLIENT, useValue: apiClient },
        {
          provide: SelectedBusinessStore,
          useValue: new FakeSelectedBusinessStore(),
        },
      ],
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
    // The route cell now carries the responsive sub-line as well, so it
    // is asserted by its parts rather than by exact equality.
    expect(cells[0]).toContain('Ikeja → CMS');
    expect(cells[1]).toBe('2026-09-01');
    expect(cells[3]).toBe('1A, 1B');
    expect(cells[4]).toBe('NGN 1500.00');
  });

  // `booking.manage` does not exist this phase: cancelling is the
  // passenger's own action, so any action affordance here would be one
  // the server refuses.
  it('offers no cancel or edit affordance', async () => {
    // `booking.manage` does not exist: cancelling is the passenger's own
    // action, so any write affordance here would be one the server
    // refuses. Slice 3b added a row menu, but it carries "View details"
    // and nothing else — asserting on the absence of the word "Cancel"
    // would be wrong, since `Cancelled` is a legitimate status label.
    await createComponent();

    const menuItems = (fixture.nativeElement as HTMLElement).querySelectorAll(
      'tbody a, tbody input'
    );
    expect(menuItems.length).toBe(0);
    expect(component['menuItems'].map((item) => item.id)).toEqual(['details']);
  });

  // A column of passenger UUIDs helps nobody; nesting an email is a
  // backend change this slice does not depend on.
  it('does not render the raw passenger uuid', async () => {
    await createComponent();

    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('user-1');
  });

  // --- docs/specs/14 slice 3b ---

  it('scopes the list to the active Business', async () => {
    // `GET /bookings/` had no `business` param, so this screen listed
    // every Business under the Client while the header switcher claimed
    // one was active.
    await createComponent();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/bookings/',
      jasmine.objectContaining({
        params: jasmine.objectContaining({
          query: jasmine.objectContaining({ business: 'biz-1' }),
        }),
      })
    );
  });

  it('fetches no trip list at all', async () => {
    // The trip dropdown is gone. It fetched `limit=100` against
    // ascending Trip ordering, so a Business with more than 100 trips
    // was offered its *oldest* hundred — the known-red recorded in
    // docs/self-check-2026-08-26-spec11.md. Search replaces it.
    await createComponent();

    const paths = apiClient.GET.calls.allArgs().map((args) => args[0]);
    expect(paths).not.toContain('/api/v1/trips/');
  });

  it('searches server-side, keeping the Business scope', async () => {
    await createComponent();

    component['onSearchChange']('ada@example.com');
    await fixture.whenStable();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/bookings/',
      jasmine.objectContaining({
        params: jasmine.objectContaining({
          query: jasmine.objectContaining({
            business: 'biz-1',
            search: 'ada@example.com',
          }),
        }),
      })
    );
  });

  it('clears a filter back to undefined rather than an empty string', async () => {
    await createComponent();

    component['onStatusFilterChange']('');
    await fixture.whenStable();

    expect(component['store'].query().status).toBeUndefined();
  });

  it('renders a chip naming the status filter readably', async () => {
    await createComponent();

    component['onStatusFilterChange']('cancelled');
    fixture.detectChanges();

    const chip = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find(
      (el) => el.getAttribute('aria-label')?.startsWith('Remove filter')
    );
    expect(chip?.textContent).toContain('Status: Cancelled');
  });

  it('shows an empty state when nothing has been booked', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });

    await createComponent();

    expect((fixture.nativeElement as HTMLElement).querySelector('ui-empty-state')).toBeTruthy();
  });
  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', async () => {
    await createComponent();

    expectColumnVisibilityParity(fixture.nativeElement, 'booking-list rows');
  });
});
