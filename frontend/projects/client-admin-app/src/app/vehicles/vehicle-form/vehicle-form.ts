import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
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
import { VehicleStore } from '../../shared/data/store/vehicle.store';
import { applyServerErrors, clearServerErrors, fieldErrorMessage } from '../../shared/form-errors';

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
  imports: [
    ReactiveFormsModule,
    RouterLink,
    Alert,
    FormSection,
    PageHeader,
    Button,
    FormSection,
    PageHeader,
    Select,
    TextField,
  ],
  templateUrl: './vehicle-form.html',
})
export class VehicleForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  protected readonly store = inject(VehicleStore);

  protected readonly vehicleId = signal<string | null>(null);
  protected readonly editing = computed(() => this.vehicleId() !== null);
  protected readonly notFound = signal(false);

  protected readonly vehicleTypeOptionsList = signal<SelectOption[]>([]);
  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  // `business` has no field in the template any more — it's resolved
  // from whichever Business is active in the header switcher.
  // Re-asking was redundant (it was pre-filled from this same value)
  // and let a user create a record under a Business other than the one
  // every other screen was showing them. The control stays purely as
  // the value carrier for create.
  protected readonly form = this.fb.nonNullable.group({
    business: ['', Validators.required],
    vehicle_type: ['', Validators.required],
    registration_number: ['', Validators.required],
    insurance_expires_at: [''],
    roadworthiness_expires_at: [''],
  });

  async ngOnInit(): Promise<void> {
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
      if (!activeBusinessId) {
        this.errorMessage.set('Select a business from the header before creating a vehicle.');
        return;
      }
      this.form.patchValue({ business: activeBusinessId });
      await this.loadVehicleTypeOptions(activeBusinessId);
      return;
    }
    this.vehicleId.set(id);

    // Paged full-list lookup, not one bounded page plus `.find()`:
    // the bounded form reported "not found" for any record outside
    // the store's current page, which on a refresh or a pasted link
    // is page 1. See `ListStore.findByIdPaged`.
    const vehicle = await this.store.findById(id);

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
    });
    this.vehicleTypeOptionsList.set(
      (data?.results ?? []).map((vt) => ({
        value: vt.id,
        label: `${vt.name} (${vt.capacity} seats)`,
      }))
    );
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
    const id = this.vehicleId();

    const { data, error } = id
      ? await this.api.PATCH('/api/v1/vehicles/{id}/', {
          params: { path: { id } },
          body: {
            registration_number: values.registration_number,
            insurance_expires_at: values.insurance_expires_at || null,
            roadworthiness_expires_at: values.roadworthiness_expires_at || null,
          },
        })
      : await this.api.POST('/api/v1/vehicles/', {
          body: {
            business: values.business,
            vehicle_type: values.vehicle_type,
            registration_number: values.registration_number,
            insurance_expires_at: values.insurance_expires_at || null,
            roadworthiness_expires_at: values.roadworthiness_expires_at || null,
          },
        });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        applyServerErrors(
          this.form,
          error,
          'Could not save this vehicle. Check your details and try again.'
        )
      );
      return;
    }

    await this.router.navigate(['/vehicles']);
  }

  /** Every field, not just those with a validator: any of them can
   * come back rejected by the server, and `fieldErrorMessage`
   * surfaces that the same way it surfaces a client-side failure. */
  protected fieldError(field: 'business' | 'vehicle_type' | 'registration_number' | 'insurance_expires_at' | 'roadworthiness_expires_at'): string | null {
    return fieldErrorMessage(this.form.controls[field]);
  }
}
