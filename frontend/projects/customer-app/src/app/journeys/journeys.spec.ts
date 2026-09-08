import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { expectColumnVisibilityParity } from '@shared-ui';
import { By } from '@angular/platform-browser';

import { Journeys } from './journeys';
import { FareJourneyStore, type FareJourney } from '../shared/data/store/fare-journey.store';

function makeFareJourney(overrides: Partial<FareJourney> = {}): FareJourney {
  return {
    id: 'journey-1',
    business: 'biz-1',
    trip: {
      id: 'trip-1',
      route: { id: 'route-1', name: 'Ikeja → CMS' },
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

class FakeFareJourneyStore {
  items = signal<FareJourney[]>([]);
  total = signal(0);
  page = signal({ limit: 25, offset: 0 });
  loading = signal(false);
  error = signal<string | null>(null);
  isEmpty = signal(false);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  changePage = jasmine.createSpy('changePage').and.resolveTo();
}

describe('Journeys', () => {
  let fixture: ComponentFixture<Journeys>;
  let store: FakeFareJourneyStore;

  beforeEach(async () => {
    store = new FakeFareJourneyStore();

    await TestBed.configureTestingModule({
      imports: [Journeys],
      providers: [{ provide: FareJourneyStore, useValue: store }],
    }).compileComponents();

    fixture = TestBed.createComponent(Journeys);
    fixture.detectChanges();
  });

  it('loads journeys on init', () => {
    expect(store.getAll).toHaveBeenCalled();
  });

  it('shows the empty state when the store has no rows', () => {
    store.isEmpty.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No journeys yet');
  });

  it('renders a row per journey with route, stops, amount, and status', () => {
    store.items.set([makeFareJourney(), makeFareJourney({ id: 'journey-2', status: 'open', amount: null })]);
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0].nativeElement.textContent).toContain('Ikeja → CMS');
    expect(rows[0].nativeElement.textContent).toContain('NGN 300.00');
    expect(rows[1].nativeElement.textContent).toContain('In progress');
    expect(rows[1].nativeElement.textContent).toContain('—');
  });

  it('calls store.changePage() when the paginator emits', () => {
    store.items.set([makeFareJourney()]);
    store.total.set(30);
    fixture.detectChanges();

    const buttons = fixture.debugElement.queryAll(By.css('button'));
    const nextButton = buttons.find((b) => (b.nativeElement.textContent as string).includes('Next'));
    nextButton?.nativeElement.click();

    expect(store.changePage).toHaveBeenCalledWith(25);
  });
  // --- docs/specs/14, responsive columns ---

  it('keeps every column hidden in the header hidden in its cells', () => {
    store.items.set([makeFareJourney()]);
    fixture.detectChanges();

    expectColumnVisibilityParity(fixture.nativeElement, 'journeys');
  });

});
