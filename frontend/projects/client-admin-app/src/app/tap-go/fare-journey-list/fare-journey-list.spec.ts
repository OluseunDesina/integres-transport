import { expectColumnVisibilityParity } from '@shared-ui';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { FareJourneyList } from './fare-journey-list';
import { FareJourneyStore, type FareJourney } from '../../shared/data/store/fare-journey.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

function makeFareJourney(overrides: Partial<FareJourney> = {}): FareJourney {
  return {
    id: 'journey-1',
    business: 'biz-1',
    trip: {
      id: 'trip-1',
      route: { id: 'route-1', name: 'Ikeja Express' },
      scheduled_departure_at: '2026-08-19T07:00:00Z',
      service_date: '2026-08-19',
    },
    passenger: 'user-1',
    status: 'closed',
    board_stop: 'Ikeja Bus Stop',
    alight_stop: 'Lekki Toll Gate',
    amount: '300.00',
    currency: 'NGN',
    boarded_at: '2026-08-19T07:05:00Z',
    alighted_at: '2026-08-19T07:35:00Z',
    created_at: '2026-08-19T07:05:00Z',
    ...overrides,
  };
}

/** The screen is business-scoped since slice 3b, so it reads the active
 * Business the same way every other list does. */
class FakeSelectedBusinessStore {
  selectedBusinessId = signal<string | null>('biz-1');
}

class FakeFareJourneyStore {
  items = signal<FareJourney[]>([]);
  total = signal(0);
  query = signal<{ status?: string }>({});
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  updateQuery = jasmine.createSpy('updateQuery').and.callFake((partial: object) => {
    this.query.set({ ...this.query(), ...partial });
    return Promise.resolve();
  });
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

describe('FareJourneyList', () => {
  let fixture: ComponentFixture<FareJourneyList>;
  let store: FakeFareJourneyStore;

  beforeEach(async () => {
    store = new FakeFareJourneyStore();

    await TestBed.configureTestingModule({
      imports: [FareJourneyList],
      providers: [
        { provide: FareJourneyStore, useValue: store },
        {
          provide: SelectedBusinessStore,
          useValue: new FakeSelectedBusinessStore(),
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(FareJourneyList);
    fixture.detectChanges();
  });

  it('scopes the query to the active Business on init', () => {
    // The only fetch trigger: an ngOnInit calling getAll() would race
    // this scoped one and briefly list every Business's journeys.
    expect(store.updateQuery).toHaveBeenCalledWith({ business: 'biz-1' });
  });

  it('shows the empty state when the store has no rows', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No pay-as-you-go journeys yet');
  });

  it('renders a row per journey with route, stops, and status', () => {
    store.items.set([
      makeFareJourney(),
      makeFareJourney({ id: 'journey-2', status: 'needs_review' }),
    ]);
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0].nativeElement.textContent).toContain('Ikeja Express');
    expect(rows[0].nativeElement.textContent).toContain('Ikeja Bus Stop');
    expect(rows[1].nativeElement.textContent).toContain('Needs review');
  });

  it('calls store.updateQuery() with the chosen status filter', () => {
    const select: HTMLSelectElement = fixture.debugElement.query(By.css('select')).nativeElement;
    select.value = 'needs_review';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(store.updateQuery).toHaveBeenCalledWith(
      jasmine.objectContaining({ business: 'biz-1', status: 'needs_review' })
    );
  });
  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', () => {
    store.items.set([makeFareJourney()]);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'fare-journey-list rows');
  });

  it('keeps the skeleton row aligned with the header too', () => {
    store.loading.set(true);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'fare-journey-list skeleton');
  });
});
