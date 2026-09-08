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

import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { StopStore } from '../../shared/data/store/stop.store';
import { applyServerErrors, clearServerErrors, fieldErrorMessage } from '../../shared/form-errors';

/**
 * One component for create (`stops/new`) and edit (`stops/:id/edit`) —
 * mirrors BusinessForm's dual-mode shape. `business` is only shown (and
 * only writable) on create — the backend's StopSerializer marks it
 * read_only after creation, matching Route's own immutable-after-create
 * business choice.
 */
@Component({
  selector: 'app-stop-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Alert,
    FormSection,
    PageHeader, Button, TextField],
  templateUrl: './stop-form.html',
})
export class StopForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  protected readonly store = inject(StopStore);

  protected readonly stopId = signal<string | null>(null);
  protected readonly editing = computed(() => this.stopId() !== null);
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
    address: [''],
    latitude: [''],
    longitude: [''],
  });

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      // Create mode: default the Business select to whichever one the
      // user currently has active — still fully changeable before
      // submit. Same reasoning as RouteForm's identical prefill.
      const activeBusinessId = this.selectedBusinessStore.selectedBusinessId();
      if (!activeBusinessId) {
        this.errorMessage.set('Select a business from the header before creating a stop.');
        return;
      }
      this.form.patchValue({ business: activeBusinessId });
      return;
    }
    this.stopId.set(id);

    // Paged full-list lookup, not one bounded page plus `.find()`:
    // the bounded form reported "not found" for any record outside
    // the store's current page, which on a refresh or a pasted link
    // is page 1. See `ListStore.findByIdPaged`.
    const stop = await this.store.findById(id);

    if (!stop) {
      this.notFound.set(true);
      return;
    }

    this.form.patchValue({
      business: stop.business,
      name: stop.name,
      address: stop.address,
      latitude: stop.latitude ?? '',
      longitude: stop.longitude ?? '',
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
    const id = this.stopId();

    const { data, error } = id
      ? await this.api.PATCH('/api/v1/stops/{id}/', {
          params: { path: { id } },
          body: {
            name: values.name,
            address: values.address,
            latitude: values.latitude || null,
            longitude: values.longitude || null,
          },
        })
      : await this.api.POST('/api/v1/stops/', {
          body: {
            business: values.business,
            name: values.name,
            address: values.address,
            latitude: values.latitude || null,
            longitude: values.longitude || null,
          },
        });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        applyServerErrors(
          this.form,
          error,
          'Could not save this stop. Check your details and try again.'
        )
      );
      return;
    }

    await this.router.navigate(['/stops']);
  }

  /** Every field, not just those with a validator: any of them can
   * come back rejected by the server, and `fieldErrorMessage`
   * surfaces that the same way it surfaces a client-side failure. */
  protected fieldError(field: 'business' | 'name' | 'address' | 'latitude' | 'longitude'): string | null {
    return fieldErrorMessage(this.form.controls[field]);
  }
}
