import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Alert, Button, Select, TextField } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { ValidateTicketService, type TicketValidationResult, type Trip } from './validate-ticket.service';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDeparture(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The validator harness's second screen — see
 * docs/specs/6-ticketing.md's "Suggested implementation slicing"
 * (Frontend Slice B). Mirrors `record-tap.ts`'s shape exactly, minus
 * the tap-type toggle and stop picker: a ticket's stop pair is already
 * encoded in the signed payload and comes back in the validation
 * result, so there's nothing to pick. No state is retained
 * client-side between scans — the server is the source of truth for
 * whether a ticket is boardable right now.
 */
@Component({
  selector: 'app-validate-ticket',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, Select, TextField, Button, Alert],
  templateUrl: './validate-ticket.html',
})
export class ValidateTicket implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly validateTicketService = inject(ValidateTicketService);

  protected readonly form = this.fb.nonNullable.group({
    serviceDate: [todayIso(), Validators.required],
    tripId: ['', Validators.required],
    payload: ['', Validators.required],
  });

  protected readonly trips = signal<Trip[]>([]);
  protected readonly loadingTrips = signal(false);

  protected readonly submitting = signal(false);
  protected readonly result = signal<
    { ok: true; data: TicketValidationResult } | { ok: false; message: string } | null
  >(null);

  protected readonly tripOptions = computed<SelectOption[]>(() => [
    { value: '', label: this.loadingTrips() ? 'Loading trips…' : 'Select a trip' },
    ...this.trips().map((trip) => ({
      value: trip.id,
      label: `${trip.route.name} — ${formatDeparture(trip.scheduled_departure_at)}`,
    })),
  ]);

  protected readonly selectedTrip = computed(() =>
    this.trips().find((trip) => trip.id === this.form.controls.tripId.value)
  );

  async ngOnInit(): Promise<void> {
    await this.loadTrips();

    this.form.controls.serviceDate.valueChanges.subscribe(() => {
      this.form.patchValue({ tripId: '' });
      void this.loadTrips();
    });
  }

  private async loadTrips(): Promise<void> {
    this.loadingTrips.set(true);
    this.trips.set(await this.validateTicketService.loadTripsForDate(this.form.controls.serviceDate.value));
    this.loadingTrips.set(false);
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid || this.submitting()) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.result.set(null);
    const { tripId, payload } = this.form.getRawValue();
    const outcome = await this.validateTicketService.validateTicket({ tripId, payload });
    this.submitting.set(false);

    if (outcome.ok) {
      this.result.set({ ok: true, data: outcome.data });
      // A payload is presented once per scan — clearing it (but not the
      // trip selection) is what makes the form ready for the next
      // passenger without an extra click, same as record-tap.ts's own
      // token reset.
      this.form.controls.payload.reset('');
    } else {
      this.result.set({ ok: false, message: outcome.message });
    }
  }
}
