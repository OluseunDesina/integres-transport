import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, Select, TextField } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { BusinessOptionsService } from '../../shared/business-options.service';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { VehicleTypeStore } from '../../shared/data/store/vehicle-type.store';

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
 * One component for create (`vehicle-types/new`) and edit
 * (`vehicle-types/:id/edit`) — mirrors StopForm's dual-mode shape.
 * `business` is only shown (and only writable) on create — the backend
 * marks it read_only after creation, same immutable-after-create choice
 * Route/Stop's own business field already made.
 */
@Component({
  selector: 'app-vehicle-type-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Alert, Button, Select, TextField],
  templateUrl: './vehicle-type-form.html',
})
export class VehicleTypeForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly businessOptions = inject(BusinessOptionsService);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  protected readonly store = inject(VehicleTypeStore);

  protected readonly vehicleTypeId = signal<string | null>(null);
  protected readonly editing = computed(() => this.vehicleTypeId() !== null);
  protected readonly notFound = signal(false);

  protected readonly businessOptionsList = signal<SelectOption[]>([]);
  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    business: ['', Validators.required],
    name: ['', Validators.required],
    capacity: [1, [Validators.required, Validators.min(1)]],
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
      const activeBusinessId = this.selectedBusinessStore.selectedBusinessId();
      if (activeBusinessId) {
        this.form.patchValue({ business: activeBusinessId });
      }
      return;
    }
    this.vehicleTypeId.set(id);

    let vehicleType = this.store.items().find((v) => v.id === id) ?? null;
    if (!vehicleType) {
      await this.store.getAll();
      vehicleType = this.store.items().find((v) => v.id === id) ?? null;
    }

    if (!vehicleType) {
      this.notFound.set(true);
      return;
    }

    this.form.patchValue({
      business: vehicleType.business,
      name: vehicleType.name,
      capacity: vehicleType.capacity,
      is_active: vehicleType.is_active ?? true,
    });
    this.form.controls.business.disable();
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
    const id = this.vehicleTypeId();

    const { data, error } = id
      ? await this.api.PATCH('/api/v1/vehicle-types/{id}/', {
          params: { path: { id } },
          body: { name: values.name, capacity: values.capacity, is_active: values.is_active },
          headers: authHeader,
        })
      : await this.api.POST('/api/v1/vehicle-types/', {
          body: { business: values.business, name: values.name, capacity: values.capacity },
          headers: authHeader,
        });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        extractFirstErrorMessage(
          error,
          'Could not save this vehicle type. Check your details and try again.'
        )
      );
      return;
    }

    await this.router.navigate(['/vehicle-types']);
  }

  protected fieldError(field: 'business' | 'name' | 'capacity'): string | null {
    const control = this.form.controls[field];
    if (!control.touched || control.valid) {
      return null;
    }
    return 'This field is required.';
  }
}
