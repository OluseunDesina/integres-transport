import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import {
  Alert,
  Button,
  FormSection,
  PageHeader,
  Select,
  TextField,
} from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { applyServerErrors, clearServerErrors, fieldErrorMessage } from '../../shared/form-errors';
import { allowedTripClassOptions, type TripClass } from '../../shared/trip-class';

const NONE_OPTION: SelectOption = { value: '', label: '— None —' };

/**
 * Create-only — manual (one-off) Trip creation. There is no
 * `trips/:id/edit` route: Trip has no plain-field PATCH, only
 * assignment/status writes, both handled inline from TripList. Same
 * Business→(scoped children) live-refetch pattern as
 * ScheduleForm/VehicleForm, extended to three scoped pickers
 * (Route/Vehicle/Driver) refetched together on Business change.
 */
@Component({
  selector: 'app-trip-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Alert,
    FormSection,
    PageHeader, Button, Select, TextField],
  templateUrl: './trip-form.html',
})
export class TripForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);

  protected readonly routeOptionsList = signal<SelectOption[]>([]);
  protected readonly vehicleOptionsList = signal<SelectOption[]>([NONE_OPTION]);
  protected readonly driverOptionsList = signal<SelectOption[]>([NONE_OPTION]);
  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  /**
   * The booking mode this Trip will be created with, shown read-only.
   *
   * It isn't a form field: `create_manual_trip()` snapshots it from
   * `route.business.booking_mode_default` server-side and ignores
   * anything the client sends, deliberately — a Trip's mode must match
   * the Business that runs it. But leaving it invisible meant an
   * operator had no way to tell, at the moment of creating a Trip,
   * whether it would come out reservation or tap-and-go. Surfacing the
   * value it will inherit closes that without pretending it's editable.
   */
  protected readonly bookingModeLabel = computed(() => {
    const id = this.selectedBusinessStore.selectedBusinessId();
    const business = this.selectedBusinessStore.items().find((b) => b.id === id);
    if (!business) {
      return null;
    }
    // Both axes, because a Trip snapshots both and the pair is what
    // actually determines how this departure behaves
    // (docs/specs/10-booking-modes.md).
    const seating =
      business.booking_mode_default === 'open_seating' ? 'Open seating' : 'Reservation';
    const collection =
      business.fare_collection_mode === 'pay_as_you_go' ? 'pay as you go' : 'prepaid';
    return `${seating}, ${collection}`;
  });

  // `business` has no field in the template any more — it's resolved
  // from whichever Business is active in the header switcher.
  // Re-asking was redundant (it was pre-filled from this same value)
  // and let a user create a record under a Business other than the one
  // every other screen was showing them. The control stays purely as
  // the value carrier for create.
  protected readonly form = this.fb.nonNullable.group({
    business: ['', Validators.required],
    route: ['', Validators.required],
    service_date: ['', Validators.required],
    departure_time: ['', Validators.required],
    vehicle: [''],
    driver: [''],
    // docs/specs/15-trip-classes.md. Unlike booking_mode above, this is
    // a real form field: the server takes it from the request rather
    // than snapshotting it from the Business, because a class is a
    // per-departure decision, not a Business-wide default.
    trip_class: ['standard' as TripClass, Validators.required],
  });

  /** Declared after `form`, and read through `toSignal` — see
   * ScheduleForm's identical note for both reasons. */
  private readonly selectedRouteId = toSignal(this.form.controls.route.valueChanges, {
    initialValue: '',
  });

  /** Narrowed to the chosen route's own allow-list, from the fetch that
   * already populates the Route picker. */
  private readonly classesByRoute = signal<ReadonlyMap<string, string[]>>(new Map());
  protected readonly tripClassOptions = computed<SelectOption[]>(() =>
    allowedTripClassOptions(this.classesByRoute().get(this.selectedRouteId()) ?? [])
  );

  /** Keeps the selected class inside the offered options — see
   * ScheduleForm's identical effect for what goes wrong without it. */
  private readonly keepClassWithinAllowed = effect(() => {
    const allowed = this.tripClassOptions();
    if (allowed.length === 0) {
      return;
    }
    const current = untracked(() => this.form.controls.trip_class.value);
    if (!allowed.some((option) => option.value === current)) {
      this.form.controls.trip_class.setValue(allowed[0].value as TripClass);
    }
  });

  async ngOnInit(): Promise<void> {
    this.form.controls.business.valueChanges.subscribe((businessId) => {
      void this.onBusinessChange(businessId);
    });
    const activeBusinessId = this.selectedBusinessStore.selectedBusinessId();
    if (!activeBusinessId) {
      this.errorMessage.set('Select a business from the header before creating a trip.');
      return;
    }
    this.form.patchValue({ business: activeBusinessId });
    await this.loadScopedOptions(activeBusinessId);
  }

  protected async onBusinessChange(businessId: string): Promise<void> {
    this.form.patchValue({ route: '', vehicle: '', driver: '' });
    await this.loadScopedOptions(businessId);
  }

  private async loadScopedOptions(businessId: string): Promise<void> {
    if (!businessId) {
      this.routeOptionsList.set([]);
      this.vehicleOptionsList.set([NONE_OPTION]);
      this.driverOptionsList.set([NONE_OPTION]);
      return;
    }
    const query = { limit: 100, offset: 0, business: businessId };
    const [routes, vehicles, drivers] = await Promise.all([
      this.api.GET('/api/v1/routes/', {
        params: { query },
      }),
      this.api.GET('/api/v1/vehicles/', {
        params: { query },
      }),
      this.api.GET('/api/v1/drivers/', {
        params: { query },
      }),
    ]);
    const routeRows = routes.data?.results ?? [];
    this.routeOptionsList.set(
      routeRows.map((route) => ({
        value: route.id,
        label: route.name,
      }))
    );
    this.classesByRoute.set(
      new Map(routeRows.map((route) => [route.id, route.available_trip_classes ?? []]))
    );
    this.vehicleOptionsList.set([
      NONE_OPTION,
      ...(vehicles.data?.results ?? []).map((vehicle) => ({
        value: vehicle.id,
        label: vehicle.registration_number,
      })),
    ]);
    this.driverOptionsList.set([
      NONE_OPTION,
      ...(drivers.data?.results ?? []).map((driver) => ({
        value: driver.id,
        label: driver.name,
      })),
    ]);
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    clearServerErrors(this.form);
    const values = this.form.getRawValue();

    const { data, error } = await this.api.POST('/api/v1/trips/', {
      body: {
        route: values.route,
        service_date: values.service_date,
        departure_time: values.departure_time,
        vehicle: values.vehicle || null,
        driver: values.driver || null,
        trip_class: values.trip_class,
      },
    });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        applyServerErrors(
          this.form,
          error,
          'Could not create this trip. Check your details and try again.'
        )
      );
      return;
    }

    await this.router.navigate(['/trips']);
  }

  /** Every field, not just those with a validator: any of them can
   * come back rejected by the server, and `fieldErrorMessage`
   * surfaces that the same way it surfaces a client-side failure. */
  protected fieldError(
    field:
      | 'business'
      | 'route'
      | 'service_date'
      | 'departure_time'
      | 'vehicle'
      | 'driver'
      | 'trip_class'
  ): string | null {
    return fieldErrorMessage(this.form.controls[field]);
  }
}
