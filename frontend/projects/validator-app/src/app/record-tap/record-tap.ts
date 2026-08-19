import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Alert, Button, Select, TextField } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { RecordTapService, type RouteStopOption, type TapEvent, type TapType, type Trip } from './record-tap.service';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDeparture(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The validator harness's one screen — see docs/specs/4b-tap-and-go.md's
 * "Operator harness" section: pick a Trip, enter/scan a token, pick a
 * tap type, pick a stop, submit, show the result. No state is retained
 * client-side between taps (no "current journey" tracking) — the server
 * is the source of truth for whether a board or alight is valid right
 * now (`apps.tapngo.services.record_tap`'s own edge cases), so this
 * component only ever submits what the operator chose and shows
 * whatever the API decided.
 */
@Component({
  selector: 'app-record-tap',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, Select, TextField, Button, Alert],
  templateUrl: './record-tap.html',
})
export class RecordTap implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly recordTapService = inject(RecordTapService);

  protected readonly form = this.fb.nonNullable.group({
    serviceDate: [todayIso(), Validators.required],
    tripId: ['', Validators.required],
    token: ['', Validators.required],
    stopId: ['', Validators.required],
  });

  protected readonly tapType = signal<TapType>('board');

  protected readonly trips = signal<Trip[]>([]);
  protected readonly loadingTrips = signal(false);
  protected readonly stops = signal<RouteStopOption[]>([]);
  protected readonly loadingStops = signal(false);

  protected readonly submitting = signal(false);
  protected readonly result = signal<{ ok: true; data: TapEvent } | { ok: false; message: string } | null>(
    null
  );

  protected readonly tripOptions = computed<SelectOption[]>(() => [
    { value: '', label: this.loadingTrips() ? 'Loading trips…' : 'Select a trip' },
    ...this.trips().map((trip) => ({
      value: trip.id,
      label: `${trip.route.name} — ${formatDeparture(trip.scheduled_departure_at)}`,
    })),
  ]);

  protected readonly stopOptions = computed<SelectOption[]>(() => [
    { value: '', label: this.loadingStops() ? 'Loading stops…' : 'Select a stop' },
    ...this.stops().map((stop) => ({ value: stop.id, label: stop.name })),
  ]);

  protected readonly selectedTrip = computed(() =>
    this.trips().find((trip) => trip.id === this.form.controls.tripId.value)
  );

  async ngOnInit(): Promise<void> {
    await this.loadTrips();

    this.form.controls.serviceDate.valueChanges.subscribe(() => {
      this.form.patchValue({ tripId: '' });
      this.stops.set([]);
      void this.loadTrips();
    });

    this.form.controls.tripId.valueChanges.subscribe((tripId) => {
      void this.onTripChange(tripId);
    });
  }

  private async loadTrips(): Promise<void> {
    this.loadingTrips.set(true);
    this.trips.set(await this.recordTapService.loadTripsForDate(this.form.controls.serviceDate.value));
    this.loadingTrips.set(false);
  }

  private async onTripChange(tripId: string): Promise<void> {
    this.form.patchValue({ stopId: '' });
    this.stops.set([]);
    const trip = this.trips().find((candidate) => candidate.id === tripId);
    if (!trip) {
      return;
    }
    this.loadingStops.set(true);
    this.stops.set(await this.recordTapService.loadRouteStops(trip.business, trip.route.id));
    this.loadingStops.set(false);
  }

  protected setTapType(tapType: TapType): void {
    this.tapType.set(tapType);
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid || this.submitting()) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.result.set(null);
    const { tripId, token, stopId } = this.form.getRawValue();
    const outcome = await this.recordTapService.recordTap({
      tripId,
      token,
      tapType: this.tapType(),
      stopId,
    });
    this.submitting.set(false);

    if (outcome.ok) {
      this.result.set({ ok: true, data: outcome.data });
      // A token is presented once per physical tap — clearing it (but
      // not the trip/stop selection) is what makes the form ready for
      // the next passenger without an extra click.
      this.form.controls.token.reset('');
    } else {
      this.result.set({ ok: false, message: outcome.message });
    }
  }
}
