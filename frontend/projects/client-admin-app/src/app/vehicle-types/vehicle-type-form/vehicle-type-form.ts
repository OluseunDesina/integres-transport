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

import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { VehicleTypeStore } from '../../shared/data/store/vehicle-type.store';
import { applyServerErrors, clearServerErrors, fieldErrorMessage } from '../../shared/form-errors';
import { TRIP_CLASS_OPTIONS, type TripClass } from '../../shared/trip-class';

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
  imports: [ReactiveFormsModule, RouterLink, Alert,
    FormSection,
    PageHeader, Button, Select, TextField],
  templateUrl: './vehicle-type-form.html',
})
export class VehicleTypeForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  protected readonly store = inject(VehicleTypeStore);

  protected readonly vehicleTypeId = signal<string | null>(null);
  protected readonly editing = computed(() => this.vehicleTypeId() !== null);
  protected readonly notFound = signal(false);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  // `business` has no field in the template any more — it's resolved
  // from whichever Business is active in the header switcher.
  // Re-asking was redundant (it was pre-filled from this same value)
  // and let a user create a record under a Business other than the one
  // every other screen was showing them. The control stays purely as
  // the value carrier for create.
  protected readonly tripClassOptions = TRIP_CLASS_OPTIONS;

  protected readonly form = this.fb.nonNullable.group({
    business: ['', Validators.required],
    name: ['', Validators.required],
    capacity: [1, [Validators.required, Validators.min(1)]],
    // docs/specs/15-trip-classes.md. Defaults to `standard` — the class
    // every vehicle type created before spec 15 backfilled to — so a
    // form submitted without touching this keeps behaving as it did.
    trip_class: ['standard' as TripClass, Validators.required],
  });

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      const activeBusinessId = this.selectedBusinessStore.selectedBusinessId();
      if (!activeBusinessId) {
        this.errorMessage.set('Select a business from the header before creating a vehicle type.');
        return;
      }
      this.form.patchValue({ business: activeBusinessId });
      return;
    }
    this.vehicleTypeId.set(id);

    // Paged full-list lookup, not one bounded page plus `.find()`:
    // the bounded form reported "not found" for any record outside
    // the store's current page, which on a refresh or a pasted link
    // is page 1. See `ListStore.findByIdPaged`.
    const vehicleType = await this.store.findById(id);

    if (!vehicleType) {
      this.notFound.set(true);
      return;
    }

    this.form.patchValue({
      business: vehicleType.business,
      name: vehicleType.name,
      capacity: vehicleType.capacity,
      // `?? 'standard'` is load-bearing, not defensive noise. The
      // generated type marks this optional (the model field has a
      // default, so DRF marks it not-required), and `patchValue`
      // *applies* an explicit `undefined` rather than skipping it —
      // which would blank a required control and make the form silently
      // unsubmittable. Standard is the value the backend would have
      // sent anyway.
      trip_class: vehicleType.trip_class ?? 'standard',
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
    clearServerErrors(this.form);
    const values = this.form.getRawValue();
    const id = this.vehicleTypeId();

    const { data, error } = id
      ? await this.api.PATCH('/api/v1/vehicle-types/{id}/', {
          params: { path: { id } },
          body: {
            name: values.name,
            capacity: values.capacity,
            trip_class: values.trip_class,
          },
        })
      : await this.api.POST('/api/v1/vehicle-types/', {
          body: {
            business: values.business,
            name: values.name,
            capacity: values.capacity,
            trip_class: values.trip_class,
          },
        });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        applyServerErrors(
          this.form,
          error,
          'Could not save this vehicle type. Check your details and try again.'
        )
      );
      return;
    }

    await this.router.navigate(['/vehicle-types']);
  }

  /** Every field, not just those with a validator: any of them can
   * come back rejected by the server, and `fieldErrorMessage`
   * surfaces that the same way it surfaces a client-side failure. */
  protected fieldError(field: 'business' | 'name' | 'capacity' | 'trip_class'): string | null {
    return fieldErrorMessage(this.form.controls[field]);
  }
}
