import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';

import { FareForm } from './fare-form';
import { SelectedBusinessStore, type Business } from '../../shared/data/store/selected-business.store';

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

class FakeSelectedBusinessStore {
  items = signal<Business[]>([makeBusiness()]);
  selectedBusinessId = signal<string | null>('biz-1');
}

async function setup(business: Business) {
  const apiClient = {
    GET: jasmine.createSpy('GET').and.resolveTo({ data: { count: 0, results: [] } }),
    POST: jasmine.createSpy('POST'),
  };
  const selectedBusinessStore = new FakeSelectedBusinessStore();
  selectedBusinessStore.items.set([business]);

  await TestBed.configureTestingModule({
    imports: [FareForm],
    providers: [
      provideRouter([]),
      { provide: API_CLIENT, useValue: apiClient },
      { provide: SelectedBusinessStore, useValue: selectedBusinessStore },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(FareForm);
  return { fixture, apiClient };
}

describe('FareForm', () => {
  describe('a flat-pricing Business', () => {
    let fixture: ComponentFixture<FareForm>;
    let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy };

    beforeEach(async () => {
      ({ fixture, apiClient } = await setup(makeBusiness({ fare_pricing_mode: 'flat' })));
      fixture.detectChanges();
      await fixture.whenStable();
    });

    it('loads route options scoped to the pre-filled Business', () => {
      expect(apiClient.GET).toHaveBeenCalledWith(
        '/api/v1/routes/',
        jasmine.objectContaining({
          params: { query: { limit: 100, offset: 0, business: 'biz-1' } },
        })
      );
    });

    it('does not show stop pickers', () => {
      expect(fixture.nativeElement.textContent).not.toContain('From stop');
    });

    it('creates a FareRule and navigates to /fares on success', async () => {
      apiClient.POST.and.resolveTo({ data: { id: 'fare-1' } });
      const router = TestBed.inject(Router);
      const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

      fixture.componentInstance['form'].setValue({
        business: 'biz-1',
        route: 'route-1',
        from_stop: '',
        to_stop: '',
        amount: '500.00',
        trip_class: '',
      });

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/fare-rules/',
        jasmine.objectContaining({
          // `trip_class: ''` — the wildcard, which is what a fare
          // entered without thinking about classes must still be, or
          // every existing pricing setup would change meaning.
          body: { business: 'biz-1', route: 'route-1', trip_class: '', amount: '500.00' },
        })
      );
      expect(navigateSpy).toHaveBeenCalledWith(['/fares']);
    });
  });

  describe('a per-segment-pricing Business', () => {
    let fixture: ComponentFixture<FareForm>;
    let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy };

    beforeEach(async () => {
      apiClient = {
        GET: jasmine.createSpy('GET').and.resolveTo({
          data: {
            count: 1,
            results: [
              {
                id: 'route-1',
                business: 'biz-1',
                name: 'Ikeja Express',
                stops: [
                  { id: 'stop-1', name: 'Ikeja Bus Stop', sequence: 1 },
                  { id: 'stop-2', name: 'Lekki Toll Gate', sequence: 2 },
                ],
              },
            ],
          },
        }),
        POST: jasmine.createSpy('POST'),
      };
      const selectedBusinessStore = new FakeSelectedBusinessStore();
      selectedBusinessStore.items.set([makeBusiness({ fare_pricing_mode: 'per_segment' })]);

      await TestBed.configureTestingModule({
        imports: [FareForm],
        providers: [
          provideRouter([]),
          { provide: API_CLIENT, useValue: apiClient },
          { provide: SelectedBusinessStore, useValue: selectedBusinessStore },
        ],
      }).compileComponents();

      fixture = TestBed.createComponent(FareForm);
      fixture.detectChanges();
      await fixture.whenStable();
    });

    it('shows stop pickers once routes (and their stops) are loaded', () => {
      expect(fixture.nativeElement.textContent).toContain('From stop');
      expect(fixture.nativeElement.textContent).toContain('To stop');
    });

    it('populates stop options from the selected route once chosen', async () => {
      fixture.componentInstance['form'].controls.route.setValue('route-1');
      await fixture.whenStable();

      expect(fixture.componentInstance['stopOptionsList']()).toEqual([
        { value: 'stop-1', label: 'Ikeja Bus Stop' },
        { value: 'stop-2', label: 'Lekki Toll Gate' },
      ]);
    });

    it('rejects submission with no from/to stop selected', async () => {
      fixture.componentInstance['form'].setValue({
        business: 'biz-1',
        route: 'route-1',
        from_stop: '',
        to_stop: '',
        amount: '300.00',
        trip_class: '',
      });

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.POST).not.toHaveBeenCalled();
      expect(fixture.componentInstance['errorMessage']()).toContain('from and to stop');
    });

    it('creates a FareSegmentRule and navigates to /fares on success', async () => {
      apiClient.POST.and.resolveTo({ data: { id: 'fare-seg-1' } });
      const router = TestBed.inject(Router);
      const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

      fixture.componentInstance['form'].setValue({
        business: 'biz-1',
        route: 'route-1',
        from_stop: 'stop-1',
        to_stop: 'stop-2',
        amount: '300.00',
        trip_class: '',
      });

      await fixture.componentInstance['onSubmit']();

      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/fare-segment-rules/',
        jasmine.objectContaining({
          body: {
            business: 'biz-1',
            route: 'route-1',
            from_stop: 'stop-1',
            to_stop: 'stop-2',
            trip_class: '',
            amount: '300.00',
          },
        })
      );
      expect(navigateSpy).toHaveBeenCalledWith(['/fares']);
    });
  });
});
