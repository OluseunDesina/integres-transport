import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, Select, TextField } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

const NONE_OPTION: SelectOption = { value: '', label: '— None —' };

function extractFirstErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    for (const value of Object.values(error as Record<string, unknown>)) {
      if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0];
      }
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  return fallback;
}

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
  imports: [ReactiveFormsModule, RouterLink, Alert, Button, Select, TextField],
  templateUrl: './trip-form.html',
})
export class TripForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
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
    return business.booking_mode_default === 'tap_and_go' ? 'Tap and go' : 'Reservation';
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
    const authHeader = {
      Authorization: `Bearer ${this.authStore.accessToken()}`,
    };
    const query = { limit: 100, offset: 0, business: businessId };
    const [routes, vehicles, drivers] = await Promise.all([
      this.api.GET('/api/v1/routes/', {
        params: { query },
        headers: authHeader,
      }),
      this.api.GET('/api/v1/vehicles/', {
        params: { query },
        headers: authHeader,
      }),
      this.api.GET('/api/v1/drivers/', {
        params: { query },
        headers: authHeader,
      }),
    ]);
    this.routeOptionsList.set(
      (routes.data?.results ?? []).map((route) => ({
        value: route.id,
        label: route.name,
      })),
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
    const values = this.form.getRawValue();
    const authHeader = {
      Authorization: `Bearer ${this.authStore.accessToken()}`,
    };

    const { data, error } = await this.api.POST('/api/v1/trips/', {
      body: {
        route: values.route,
        service_date: values.service_date,
        departure_time: values.departure_time,
        vehicle: values.vehicle || null,
        driver: values.driver || null,
      },
      headers: authHeader,
    });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        extractFirstErrorMessage(
          error,
          'Could not create this trip. Check your details and try again.',
        ),
      );
      return;
    }

    await this.router.navigate(['/trips']);
  }

  protected fieldError(
    field: 'business' | 'route' | 'service_date' | 'departure_time',
  ): string | null {
    const control = this.form.controls[field];
    if (!control.touched || control.valid) {
      return null;
    }
    return 'This field is required.';
  }
}
