import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, Select, TextField } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { BusinessOptionsService } from '../../shared/business-options.service';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { VehicleStore } from '../../shared/data/store/vehicle.store';

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
 * One component for create (`vehicles/new`) and edit
 * (`vehicles/:id/edit`) — mirrors StopForm's dual-mode shape. The
 * `vehicle_type` picker is scoped to whichever Business is currently
 * chosen, fetched directly via GET /vehicle-types/?business=<id> (the
 * same server-side filter Route/Stop's own ?business= param already
 * proved) rather than a generic options service — mirrors RouteForm's
 * loadAvailableStops(businessId) exactly, since both need to re-filter
 * live as the Business selection changes, not just load once.
 */
@Component({
  selector: 'app-vehicle-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Alert, Button, Select, TextField],
  templateUrl: './vehicle-form.html',
})
export class VehicleForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly businessOptions = inject(BusinessOptionsService);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  protected readonly store = inject(VehicleStore);

  protected readonly vehicleId = signal<string | null>(null);
  protected readonly editing = computed(() => this.vehicleId() !== null);
  protected readonly notFound = signal(false);

  protected readonly businessOptionsList = signal<SelectOption[]>([]);
  protected readonly vehicleTypeOptionsList = signal<SelectOption[]>([]);
  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    business: ['', Validators.required],
    vehicle_type: ['', Validators.required],
    registration_number: ['', Validators.required],
    insurance_expires_at: [''],
    roadworthiness_expires_at: [''],
    is_active: [true],
  });

  async ngOnInit(): Promise<void> {
    try {
      this.businessOptionsList.set(await this.businessOptions.loadOptions());
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to load businesses.');
    }

    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      // Business stays user-changeable on create, so the vehicle-type
      // options must re-fetch live as it changes — a plain valueChanges
      // subscription is the standard way to react to a formControlName
      // control's changes without ui-select needing its own (change)
      // output (it's CVA-only, matching TextField/Select's shape).
      this.form.controls.business.valueChanges.subscribe((businessId) => {
        void this.onBusinessChange(businessId);
      });
      const activeBusinessId = this.selectedBusinessStore.selectedBusinessId();
      if (activeBusinessId) {
        this.form.patchValue({ business: activeBusinessId });
        await this.loadVehicleTypeOptions(activeBusinessId);
      }
      return;
    }
    this.vehicleId.set(id);

    let vehicle = this.store.items().find((v) => v.id === id) ?? null;
    if (!vehicle) {
      await this.store.getAll();
      vehicle = this.store.items().find((v) => v.id === id) ?? null;
    }

    if (!vehicle) {
      this.notFound.set(true);
      return;
    }

    await this.loadVehicleTypeOptions(vehicle.business);
    this.form.patchValue({
      business: vehicle.business,
      vehicle_type: vehicle.vehicle_type,
      registration_number: vehicle.registration_number,
      insurance_expires_at: vehicle.insurance_expires_at ?? '',
      roadworthiness_expires_at: vehicle.roadworthiness_expires_at ?? '',
      is_active: vehicle.is_active ?? true,
    });
    this.form.controls.business.disable();
    this.form.controls.vehicle_type.disable();
  }

  protected async onBusinessChange(businessId: string): Promise<void> {
    this.form.patchValue({ vehicle_type: '' });
    await this.loadVehicleTypeOptions(businessId);
  }

  private async loadVehicleTypeOptions(businessId: string): Promise<void> {
    if (!businessId) {
      this.vehicleTypeOptionsList.set([]);
      return;
    }
    const { data } = await this.api.GET('/api/v1/vehicle-types/', {
      params: { query: { limit: 100, offset: 0, business: businessId } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    this.vehicleTypeOptionsList.set(
      (data?.results ?? []).map((vt) => ({ value: vt.id, label: `${vt.name} (${vt.capacity} seats)` }))
    );
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
    const id = this.vehicleId();

    const { data, error } = id
      ? await this.api.PATCH('/api/v1/vehicles/{id}/', {
          params: { path: { id } },
          body: {
            registration_number: values.registration_number,
            insurance_expires_at: values.insurance_expires_at || null,
            roadworthiness_expires_at: values.roadworthiness_expires_at || null,
            is_active: values.is_active,
          },
          headers: authHeader,
        })
      : await this.api.POST('/api/v1/vehicles/', {
          body: {
            business: values.business,
            vehicle_type: values.vehicle_type,
            registration_number: values.registration_number,
            insurance_expires_at: values.insurance_expires_at || null,
            roadworthiness_expires_at: values.roadworthiness_expires_at || null,
          },
          headers: authHeader,
        });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        extractFirstErrorMessage(
          error,
          'Could not save this vehicle. Check your details and try again.'
        )
      );
      return;
    }

    await this.router.navigate(['/vehicles']);
  }

  protected fieldError(field: 'business' | 'vehicle_type' | 'registration_number'): string | null {
    const control = this.form.controls[field];
    if (!control.touched || control.valid) {
      return null;
    }
    return 'This field is required.';
  }
}
