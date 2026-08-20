import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore, HasPermissionDirective } from '@auth';
import { Alert, Button, EmptyState, TextField } from '@shared-ui';

import { VehicleTypeStore } from '../../shared/data/store/vehicle-type.store';

type Seat = components['schemas']['Seat'];

interface GridSeat {
  seatNumber: string;
  row: number | null;
  column: number | null;
}

interface GridRow {
  row: number | null;
  segments: GridSeat[][];
}

/** Splits a row's seats (already sorted by column) wherever the
 * `column` integer jumps by more than 1 — the signal a physical-layout
 * aisle leaves behind (docs/specs/8-seat-map-generation.md's Edge case
 * §5), mirrored from customer-app's seat-picker.ts. Duplicated rather
 * than shared: different seat shapes, different apps, same reasoning
 * seat-picker.ts's own docstring already gives for staying app-local. */
function splitAtAisleGaps(seats: GridSeat[]): GridSeat[][] {
  const segments: GridSeat[][] = [];
  let current: GridSeat[] = [];
  let previousColumn: number | null = null;
  for (const seat of seats) {
    if (previousColumn !== null && seat.column !== null && seat.column - previousColumn > 1) {
      segments.push(current);
      current = [];
    }
    current.push(seat);
    previousColumn = seat.column;
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

function groupSeatsIntoRows(seats: GridSeat[]): GridRow[] {
  if (seats.every((seat) => seat.row === null)) {
    return [{ row: null, segments: [seats] }];
  }
  const byRow = new Map<number | null, GridSeat[]>();
  for (const seat of seats) {
    byRow.set(seat.row, [...(byRow.get(seat.row) ?? []), seat]);
  }
  return [...byRow.entries()]
    .sort((a, b) => (a[0] ?? Number.MAX_SAFE_INTEGER) - (b[0] ?? Number.MAX_SAFE_INTEGER))
    .map(([row, rowSeats]) => {
      const sorted = [...rowSeats].sort((a, b) => (a.column ?? 0) - (b.column ?? 0));
      return { row, segments: splitAtAisleGaps(sorted) };
    });
}

const SEAT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Client-side mirror of apps.seating.services.generate_seat_layout() —
 * pure preview, never written until "Generate" is submitted. Must stay
 * in lockstep with the backend's column-jump behavior for the aisle
 * preview to match what actually gets saved. */
function computeLayoutPreview(
  rows: number,
  columns: number,
  aisleAfterColumn: number | null
): GridSeat[] {
  const seats: GridSeat[] = [];
  for (let row = 1; row <= rows; row++) {
    let column = 0;
    for (let seatIndex = 1; seatIndex <= columns; seatIndex++) {
      column += 1;
      if (aisleAfterColumn !== null && column === aisleAfterColumn + 1) {
        column += 1;
      }
      seats.push({ seatNumber: `${row}${SEAT_LETTERS[seatIndex - 1]}`, row, column });
    }
  }
  return seats;
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return fallback;
}

/**
 * Rows x columns (+ optional aisle) seat-map generator —
 * docs/specs/8-seat-map-generation.md. The only seat-creation UI in
 * this workspace: `POST /vehicle-types/{id}/seats/generate/` has had
 * zero frontend consumers since Phase 4, and this spec deliberately
 * builds generation as the only path rather than a manual editor first.
 *
 * The preview grid is computed entirely client-side
 * (`computeLayoutPreview`) — generation is a real replace-the-set
 * write, so nothing is sent to the backend until "Generate" is
 * explicitly submitted.
 */
@Component({
  selector: 'app-seat-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, HasPermissionDirective, Alert, Button, EmptyState, TextField],
  templateUrl: './seat-map.html',
})
export class SeatMap implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  protected readonly store = inject(VehicleTypeStore);

  private readonly vehicleTypeId = this.route.snapshot.paramMap.get('id') ?? '';
  protected readonly notFound = signal(false);
  protected readonly vehicleType = computed(
    () => this.store.items().find((vt) => vt.id === this.vehicleTypeId) ?? null
  );

  protected readonly existingSeats = signal<Seat[]>([]);
  protected readonly loadingSeats = signal(false);
  protected readonly seatsError = signal<string | null>(null);

  protected readonly rowsInput = signal('4');
  protected readonly columnsInput = signal('4');
  protected readonly aisleInput = signal('');

  protected readonly generating = signal(false);
  protected readonly generateError = signal<string | null>(null);

  protected readonly rows = computed(() => Number.parseInt(this.rowsInput(), 10) || 0);
  protected readonly columns = computed(() => Number.parseInt(this.columnsInput(), 10) || 0);
  protected readonly aisleAfterColumn = computed(() =>
    this.aisleInput().trim() === '' ? null : Number.parseInt(this.aisleInput(), 10)
  );

  protected readonly totalSeats = computed(() => this.rows() * this.columns());

  protected readonly exceedsCapacity = computed(() => {
    const vehicleType = this.vehicleType();
    return vehicleType !== null && this.totalSeats() > vehicleType.capacity;
  });

  protected readonly invalidAislePosition = computed(() => {
    const aisle = this.aisleAfterColumn();
    return aisle !== null && aisle >= this.columns();
  });

  protected readonly canGenerate = computed(
    () =>
      this.rows() >= 1 &&
      this.columns() >= 1 &&
      !this.exceedsCapacity() &&
      !this.invalidAislePosition() &&
      !this.generating()
  );

  protected readonly previewRows = computed<GridRow[]>(() =>
    groupSeatsIntoRows(computeLayoutPreview(this.rows(), this.columns(), this.aisleAfterColumn()))
  );

  protected readonly existingGridRows = computed<GridRow[]>(() =>
    groupSeatsIntoRows(
      this.existingSeats().map((seat) => ({
        seatNumber: seat.seat_number,
        row: seat.row,
        column: seat.column,
      }))
    )
  );

  async ngOnInit(): Promise<void> {
    if (!this.vehicleTypeId) {
      this.notFound.set(true);
      return;
    }
    if (!this.vehicleType()) {
      await this.store.getAll();
    }
    if (!this.vehicleType()) {
      this.notFound.set(true);
      return;
    }
    await this.loadSeats();
  }

  private async loadSeats(): Promise<void> {
    this.loadingSeats.set(true);
    this.seatsError.set(null);
    const { data, error } = await this.api.GET('/api/v1/vehicle-types/{id}/seats/', {
      params: { path: { id: this.vehicleTypeId } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    this.loadingSeats.set(false);
    if (!data) {
      this.seatsError.set(toErrorMessage(error, 'Could not load this vehicle type’s seats.'));
      return;
    }
    this.existingSeats.set(data);
  }

  protected setRowsInput(value: string): void {
    this.rowsInput.set(value);
  }

  protected setColumnsInput(value: string): void {
    this.columnsInput.set(value);
  }

  protected setAisleInput(value: string): void {
    this.aisleInput.set(value);
  }

  protected async generate(): Promise<void> {
    if (!this.canGenerate()) {
      return;
    }
    this.generating.set(true);
    this.generateError.set(null);
    const { data, error } = await this.api.POST('/api/v1/vehicle-types/{id}/seats/generate/', {
      params: { path: { id: this.vehicleTypeId } },
      body: {
        rows: this.rows(),
        columns: this.columns(),
        aisle_after_column: this.aisleAfterColumn(),
        numbering_scheme: 'row_letter',
      },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    this.generating.set(false);
    if (!data) {
      this.generateError.set(
        toErrorMessage(error, 'Could not generate this seat map. Try again.')
      );
      return;
    }
    this.existingSeats.set(data);
  }
}
