import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Alert, Button, Select, TextField } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { ValidateTicketService, type TicketValidationResult } from '../validate-ticket/validate-ticket.service';
import { RecordTapService, type RouteStopOption, type TapEvent, type TapType, type Trip } from './record-tap.service';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDeparture(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

type TapOutcome =
  | { ok: true; kind: 'journey'; data: TapEvent }
  | { ok: true; kind: 'ticket'; data: TicketValidationResult }
  | { ok: false; message: string };

/**
 * The one scan screen — see docs/specs/4b-tap-and-go.md's "Operator
 * harness" section and docs/specs/10-booking-modes.md's universal tap:
 * pick a Trip, scan or type a credential, submit, show the result.
 *
 * **What a tap means depends on the trip, not on the screen.** A
 * credential is universal fare media; the fare model is not. On a
 * pay-as-you-go trip a tap opens or closes a `FareJourney`, so the
 * operator also picks board/alight and a stop. On a prepaid trip it
 * boards the Ticket the passenger already holds, and neither of those
 * questions has an answer — the journey is already fixed by what they
 * bought — so both controls are hidden and disabled.
 *
 * No state is retained client-side between taps (no "current journey"
 * tracking) — the server is the source of truth for whether a tap is
 * valid right now, so this component only ever submits what the
 * operator chose and shows whatever the API decided.
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
  private readonly validateTicketService = inject(ValidateTicketService);

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
  protected readonly result = signal<TapOutcome | null>(null);

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

  /** The selected trip id as a signal. A `computed` reading
   * `form.controls.tripId.value` directly would depend on no signal at
   * all: it evaluates once and then caches forever, so everything
   * derived from the selection silently freezes on whatever was
   * selected at first render (nothing). Found by the e2e spec, which
   * unlike the unit tests renders between each step. */
  private readonly selectedTripId = toSignal(this.form.controls.tripId.valueChanges, {
    initialValue: '',
  });

  protected readonly selectedTrip = computed(() =>
    this.trips().find((trip) => trip.id === this.selectedTripId())
  );

  /** Drives which half of the form is shown. Undefined until a trip is
   * picked, which is why this is a three-state read rather than a
   * boolean: before a selection there is no answer, and defaulting to
   * either mode would show controls that may be about to disappear. */
  protected readonly fareCollectionMode = computed(
    () => this.selectedTrip()?.fare_collection_mode
  );
  protected readonly isPrepaid = computed(() => this.fareCollectionMode() === 'prepaid');

  async ngOnInit(): Promise<void> {
    // Subscribed before the first load is awaited — see
    // `validate-ticket.ts`'s note on the same ordering: the other way
    // round silently drops a date changed while the initial request is
    // still in flight, leaving the picker on a different day from the
    // date field.
    this.form.controls.serviceDate.valueChanges.subscribe(() => {
      this.form.patchValue({ tripId: '' });
      this.stops.set([]);
      void this.loadTrips();
    });

    this.form.controls.tripId.valueChanges.subscribe((tripId) => {
      void this.onTripChange(tripId);
    });

    await this.loadTrips();
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
    // Disabled, not merely hidden: `stopId` is `Validators.required`,
    // and a hidden-but-required control leaves the form invalid with
    // nothing on screen to explain why — the submit button would just
    // do nothing on a prepaid trip.
    if (trip?.fare_collection_mode === 'prepaid') {
      this.form.controls.stopId.disable();
    } else {
      this.form.controls.stopId.enable();
    }
    if (!trip || trip.fare_collection_mode === 'prepaid') {
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
    const outcome = this.isPrepaid()
      ? await this.boardTicket(tripId, token)
      : await this.openOrCloseJourney(tripId, token, stopId);
    this.submitting.set(false);
    this.result.set(outcome);

    if (outcome.ok) {
      // A token is presented once per physical tap — clearing it (but
      // not the trip/stop selection) is what makes the form ready for
      // the next passenger without an extra click.
      this.form.controls.token.reset('');
    }
  }

  private async boardTicket(tripId: string, token: string): Promise<TapOutcome> {
    const outcome = await this.validateTicketService.validateCredential({ tripId, token });
    return outcome.ok
      ? { ok: true, kind: 'ticket', data: outcome.data }
      : { ok: false, message: outcome.message };
  }

  private async openOrCloseJourney(
    tripId: string,
    token: string,
    stopId: string
  ): Promise<TapOutcome> {
    const outcome = await this.recordTapService.recordTap({
      tripId,
      token,
      tapType: this.tapType(),
      stopId,
    });
    return outcome.ok
      ? { ok: true, kind: 'journey', data: outcome.data }
      : { ok: false, message: outcome.message };
  }
}
