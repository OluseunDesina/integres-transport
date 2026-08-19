import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, Select, TextField } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { BusinessOptionsService } from '../../shared/business-options.service';
import { DriverStore } from '../../shared/data/store/driver.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

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
 * One component for create (`drivers/new`) and edit (`drivers/:id/edit`)
 * — mirrors StopForm's dual-mode shape almost exactly (business picker
 * on create only, plain fields, one date input).
 */
@Component({
  selector: 'app-driver-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Alert, Button, Select, TextField],
  templateUrl: './driver-form.html',
})
export class DriverForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly businessOptions = inject(BusinessOptionsService);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  protected readonly store = inject(DriverStore);

  protected readonly driverId = signal<string | null>(null);
  protected readonly editing = computed(() => this.driverId() !== null);
  protected readonly notFound = signal(false);

  protected readonly businessOptionsList = signal<SelectOption[]>([]);
  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    business: ['', Validators.required],
    name: ['', Validators.required],
    phone: [''],
    license_number: ['', Validators.required],
    license_expires_at: [''],
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
    this.driverId.set(id);

    let driver = this.store.items().find((d) => d.id === id) ?? null;
    if (!driver) {
      await this.store.getAll();
      driver = this.store.items().find((d) => d.id === id) ?? null;
    }

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
      is_active: driver.is_active ?? true,
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
    const id = this.driverId();

    const { data, error } = id
      ? await this.api.PATCH('/api/v1/drivers/{id}/', {
          params: { path: { id } },
          body: {
            name: values.name,
            phone: values.phone,
            license_number: values.license_number,
            license_expires_at: values.license_expires_at || null,
            is_active: values.is_active,
          },
          headers: authHeader,
        })
      : await this.api.POST('/api/v1/drivers/', {
          body: {
            business: values.business,
            name: values.name,
            phone: values.phone,
            license_number: values.license_number,
            license_expires_at: values.license_expires_at || null,
          },
          headers: authHeader,
        });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        extractFirstErrorMessage(error, 'Could not save this driver. Check your details and try again.')
      );
      return;
    }

    await this.router.navigate(['/drivers']);
  }

  protected fieldError(field: 'business' | 'name' | 'license_number'): string | null {
    const control = this.form.controls[field];
    if (!control.touched || control.valid) {
      return null;
    }
    return 'This field is required.';
  }
}
