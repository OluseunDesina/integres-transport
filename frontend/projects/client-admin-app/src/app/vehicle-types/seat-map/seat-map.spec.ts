import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { SeatMap } from './seat-map';
import { VehicleTypeStore, type VehicleType } from '../../shared/data/store/vehicle-type.store';

type Seat = components['schemas']['Seat'];

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    email: 'owner@example.com',
    firstName: '',
    lastName: '',
    client: 'client-1',
    isPlatformStaff: false,
    isClientStaff: true,
    permissions: ['client-admin:access', 'seating.view', 'seating.manage'],
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
    capacity: 6,
    is_active: true,
    created_at: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

function makeSeat(overrides: Partial<Seat> = {}): Seat {
  return {
    id: 'seat-1',
    vehicle_type: 'vt-1',
    seat_number: '1A',
    row: 1,
    column: 1,
    is_active: true,
    created_at: '2026-08-19T00:00:00Z',
    ...overrides,
  };
}

class FakeVehicleTypeStore {
  items = signal<VehicleType[]>([]);
  getAll = jasmine.createSpy('getAll').and.resolveTo();
  /** Mirrors `ListStore.findByIdPaged`: match the loaded rows, else
   * null. The component must never read `items()` and `.find()` for
   * itself — doing so is what made any record past the store's
   * current page report "not found" on a refresh. */
  findById = jasmine
    .createSpy('findById')
    .and.callFake((id: string) =>
      Promise.resolve(this.items().find((item) => item.id === id) ?? null)
    );
}

async function setup(paramId: string | null, existingVehicleTypes: VehicleType[] = []) {
  const apiClient = { GET: jasmine.createSpy('GET'), POST: jasmine.createSpy('POST') };
  apiClient.GET.and.resolveTo({ data: [] });
  const store = new FakeVehicleTypeStore();
  store.items.set(existingVehicleTypes);

  await TestBed.configureTestingModule({
    imports: [SeatMap],
    providers: [
      provideRouter([]),
      { provide: API_CLIENT, useValue: apiClient },
      { provide: VehicleTypeStore, useValue: store },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap(paramId ? { id: paramId } : {}) } },
      },
    ],
  }).compileComponents();

  const authStore = TestBed.inject(AuthStore);
  authStore.setSession('a', 'r', makeUser());

  const fixture = TestBed.createComponent(SeatMap);
  return { fixture, apiClient, store, authStore };
}

describe('SeatMap', () => {
  let fixture: ComponentFixture<SeatMap>;
  let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy };

  it('shows a not-found message for an unknown vehicle type id', async () => {
    const { fixture: notFoundFixture } = await setup('missing-id', []);
    notFoundFixture.detectChanges();
    await notFoundFixture.whenStable();
    notFoundFixture.detectChanges();

    expect(notFoundFixture.nativeElement.textContent).toContain("couldn't be found");
  });

  describe('with an existing vehicle type', () => {
    beforeEach(async () => {
      ({ fixture, apiClient } = await setup('vt-1', [makeVehicleType()]));
    });

    it('loads and renders the existing seat layout', async () => {
      apiClient.GET.and.resolveTo({
        data: [
          makeSeat({ id: 's1', seat_number: '1A', row: 1, column: 1 }),
          makeSeat({ id: 's2', seat_number: '1B', row: 1, column: 2 }),
        ],
      });

      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain('2 seat(s) configured');
      expect(fixture.nativeElement.textContent).toContain('1A');
      expect(fixture.nativeElement.textContent).toContain('1B');
    });

    it('shows an empty state when no seats are configured yet', async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.nativeElement.textContent).toContain('No seats configured yet');
    });

    it('previews a generated layout client-side without calling the API', async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      fixture.componentInstance['setRowsInput']('2');
      fixture.componentInstance['setColumnsInput']('3');
      fixture.detectChanges();

      expect(fixture.componentInstance['previewRows']()).toEqual([
        {
          row: 1,
          segments: [
            [
              { seatNumber: '1A', row: 1, column: 1 },
              { seatNumber: '1B', row: 1, column: 2 },
              { seatNumber: '1C', row: 1, column: 3 },
            ],
          ],
        },
        {
          row: 2,
          segments: [
            [
              { seatNumber: '2A', row: 2, column: 1 },
              { seatNumber: '2B', row: 2, column: 2 },
              { seatNumber: '2C', row: 2, column: 3 },
            ],
          ],
        },
      ]);
      expect(apiClient.POST).not.toHaveBeenCalled();
    });

    it('splits the preview into segments across an aisle', async () => {
      fixture.componentInstance['setRowsInput']('1');
      fixture.componentInstance['setColumnsInput']('4');
      fixture.componentInstance['setAisleInput']('2');
      fixture.detectChanges();
      await fixture.whenStable();

      const rows = fixture.componentInstance['previewRows']();
      expect(rows[0].segments.map((segment) => segment.map((s) => s.seatNumber))).toEqual([
        ['1A', '1B'],
        ['1C', '1D'],
      ]);
      expect(rows[0].segments.map((segment) => segment.map((s) => s.column))).toEqual([
        [1, 2],
        [4, 5],
      ]);
    });

    it('disables Generate when rows x columns exceeds capacity', async () => {
      fixture.componentInstance['setRowsInput']('3');
      fixture.componentInstance['setColumnsInput']('3');
      fixture.detectChanges();
      // `whenStable` because the vehicle type is now resolved by an
      // awaited `findById` rather than read synchronously off the
      // store's loaded page — and `exceedsCapacity` reads its capacity.
      await fixture.whenStable();
      fixture.detectChanges();

      expect(fixture.componentInstance['exceedsCapacity']()).toBeTrue();
      expect(fixture.componentInstance['canGenerate']()).toBeFalse();
    });

    it('disables Generate when the aisle position is not less than columns', async () => {
      fixture.componentInstance['setRowsInput']('1');
      fixture.componentInstance['setColumnsInput']('3');
      fixture.componentInstance['setAisleInput']('3');
      fixture.detectChanges();

      expect(fixture.componentInstance['invalidAislePosition']()).toBeTrue();
      expect(fixture.componentInstance['canGenerate']()).toBeFalse();
    });

    it('generates a layout and updates the current-layout panel from the response', async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.componentInstance['setRowsInput']('1');
      fixture.componentInstance['setColumnsInput']('2');
      const generated = [
        makeSeat({ id: 'g1', seat_number: '1A', row: 1, column: 1 }),
        makeSeat({ id: 'g2', seat_number: '1B', row: 1, column: 2 }),
      ];
      apiClient.POST.and.resolveTo({ data: generated });

      await fixture.componentInstance['generate']();
      fixture.detectChanges();

      expect(apiClient.POST).toHaveBeenCalledWith(
        '/api/v1/vehicle-types/{id}/seats/generate/',
        jasmine.objectContaining({
          params: { path: { id: 'vt-1' } },
          body: { rows: 1, columns: 2, aisle_after_column: null, numbering_scheme: 'row_letter' },
        })
      );
      expect(fixture.componentInstance['existingSeats']()).toEqual(generated);
    });

    it('shows the server error message when generation fails (e.g. SeatsInUse)', async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.componentInstance['setRowsInput']('1');
      fixture.componentInstance['setColumnsInput']('2');
      apiClient.POST.and.resolveTo({
        error: { detail: "This vehicle type's seats can't be regenerated: 1 seat(s)..." },
      });

      await fixture.componentInstance['generate']();
      fixture.detectChanges();

      expect(fixture.componentInstance['generateError']()).toContain("can't be regenerated");
    });
  });
});
