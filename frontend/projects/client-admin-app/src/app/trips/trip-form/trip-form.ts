import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, Select, TextField } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { BusinessOptionsService } from '../../shared/business-options.service';
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
  private readonly businessOptions = inject(BusinessOptionsService);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);

  protected readonly businessOptionsList = signal<SelectOption[]>([]);
  protected readonly routeOptionsList = signal<SelectOption[]>([]);
  protected readonly vehicleOptionsList = signal<SelectOption[]>([NONE_OPTION]);
  protected readonly driverOptionsList = signal<SelectOption[]>([NONE_OPTION]);
  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    business: ['', Validators.required],
    route: ['', Validators.required],
    service_date: ['', Validators.required],
    departure_time: ['', Validators.required],
    vehicle: [''],
    driver: [''],
  });

  async ngOnInit(): Promise<void> {
    try {
      this.businessOptionsList.set(await this.businessOptions.loadOptions());
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to load businesses.');
    }

    this.form.controls.business.valueChanges.subscribe((businessId) => {
      void this.onBusinessChange(businessId);
    });
    const activeBusinessId = this.selectedBusinessStore.selectedBusinessId();
    if (activeBusinessId) {
      this.form.patchValue({ business: activeBusinessId });
      await this.loadScopedOptions(activeBusinessId);
    }
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
    const authHeader = { Authorization: `Bearer ${this.authStore.accessToken()}` };
    const query = { limit: 100, offset: 0, business: businessId };
    const [routes, vehicles, drivers] = await Promise.all([
      this.api.GET('/api/v1/routes/', { params: { query }, headers: authHeader }),
      this.api.GET('/api/v1/vehicles/', { params: { query }, headers: authHeader }),
      this.api.GET('/api/v1/drivers/', { params: { query }, headers: authHeader }),
    ]);
    this.routeOptionsList.set(
      (routes.data?.results ?? []).map((route) => ({ value: route.id, label: route.name }))
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
      ...(drivers.data?.results ?? []).map((driver) => ({ value: driver.id, label: driver.name })),
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
    const authHeader = { Authorization: `Bearer ${this.authStore.accessToken()}` };

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
          'Could not create this trip. Check your details and try again.'
        )
      );
      return;
    }

    await this.router.navigate(['/trips']);
  }

  protected fieldError(field: 'business' | 'route' | 'service_date' | 'departure_time'): string | null {
    const control = this.form.controls[field];
    if (!control.touched || control.valid) {
      return null;
    }
    return 'This field is required.';
  }
}
