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
  TextField,
} from '@shared-ui';

import { DriverStore } from '../../shared/data/store/driver.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { applyServerErrors, clearServerErrors, fieldErrorMessage } from '../../shared/form-errors';

/**
 * One component for create (`drivers/new`) and edit (`drivers/:id/edit`)
 * — mirrors StopForm's dual-mode shape almost exactly (business picker
 * on create only, plain fields, one date input).
 */
@Component({
  selector: 'app-driver-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Alert,
    FormSection,
    PageHeader, Button, TextField],
  templateUrl: './driver-form.html',
})
export class DriverForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  protected readonly store = inject(DriverStore);

  protected readonly driverId = signal<string | null>(null);
  protected readonly editing = computed(() => this.driverId() !== null);
  protected readonly notFound = signal(false);

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
    name: ['', Validators.required],
    phone: [''],
    license_number: ['', Validators.required],
    license_expires_at: [''],
  });

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      const activeBusinessId = this.selectedBusinessStore.selectedBusinessId();
      if (!activeBusinessId) {
        this.errorMessage.set('Select a business from the header before creating a driver.');
        return;
      }
      this.form.patchValue({ business: activeBusinessId });
      return;
    }
    this.driverId.set(id);

    // Paged full-list lookup, not one bounded page plus `.find()`:
    // the bounded form reported "not found" for any record outside
    // the store's current page, which on a refresh or a pasted link
    // is page 1. See `ListStore.findByIdPaged`.
    const driver = await this.store.findById(id);

    if (!driver) {
      this.notFound.set(true);
      return;
    }

    this.form.patchValue({
      business: driver.business,
      name: driver.name,
      phone: driver.phone,
      license_number: driver.license_number,
      license_expires_at: driver.license_expires_at ?? '',
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
    const id = this.driverId();

    const { data, error } = id
      ? await this.api.PATCH('/api/v1/drivers/{id}/', {
          params: { path: { id } },
          body: {
            name: values.name,
            phone: values.phone,
            license_number: values.license_number,
            license_expires_at: values.license_expires_at || null,
          },
        })
      : await this.api.POST('/api/v1/drivers/', {
          body: {
            business: values.business,
            name: values.name,
            phone: values.phone,
            license_number: values.license_number,
            license_expires_at: values.license_expires_at || null,
          },
        });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        applyServerErrors(
          this.form,
          error,
          'Could not save this driver. Check your details and try again.'
        )
      );
      return;
    }

    await this.router.navigate(['/drivers']);
  }

  /** Every field, not just those with a validator: any of them can
   * come back rejected by the server, and `fieldErrorMessage`
   * surfaces that the same way it surfaces a client-side failure. */
  protected fieldError(field: 'business' | 'name' | 'phone' | 'license_number' | 'license_expires_at'): string | null {
    return fieldErrorMessage(this.form.controls[field]);
  }
}
