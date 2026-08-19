import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, Select, TextField } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { BusinessOptionsService } from '../../shared/business-options.service';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { StopStore } from '../../shared/data/store/stop.store';

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
 * One component for create (`stops/new`) and edit (`stops/:id/edit`) —
 * mirrors BusinessForm's dual-mode shape. `business` is only shown (and
 * only writable) on create — the backend's StopSerializer marks it
 * read_only after creation, matching Route's own immutable-after-create
 * business choice.
 */
@Component({
  selector: 'app-stop-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Alert, Button, Select, TextField],
  templateUrl: './stop-form.html',
})
export class StopForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly businessOptions = inject(BusinessOptionsService);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  protected readonly store = inject(StopStore);

  protected readonly stopId = signal<string | null>(null);
  protected readonly editing = computed(() => this.stopId() !== null);
  protected readonly notFound = signal(false);

  protected readonly businessOptionsList = signal<SelectOption[]>([]);
  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    business: ['', Validators.required],
    name: ['', Validators.required],
    address: [''],
    latitude: [''],
    longitude: [''],
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
      // Create mode: default the Business select to whichever one the
      // user currently has active — still fully changeable before
      // submit. Same reasoning as RouteForm's identical prefill.
      const activeBusinessId = this.selectedBusinessStore.selectedBusinessId();
      if (activeBusinessId) {
        this.form.patchValue({ business: activeBusinessId });
      }
      return;
    }
    this.stopId.set(id);

    let stop = this.store.items().find((s) => s.id === id) ?? null;
    if (!stop) {
      await this.store.getAll();
      stop = this.store.items().find((s) => s.id === id) ?? null;
    }

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
      is_active: stop.is_active ?? true,
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
    const id = this.stopId();

    const { data, error } = id
      ? await this.api.PATCH('/api/v1/stops/{id}/', {
          params: { path: { id } },
          body: {
            name: values.name,
            address: values.address,
            latitude: values.latitude || null,
            longitude: values.longitude || null,
            is_active: values.is_active,
          },
          headers: authHeader,
        })
      : await this.api.POST('/api/v1/stops/', {
          body: {
            business: values.business,
            name: values.name,
            address: values.address,
            latitude: values.latitude || null,
            longitude: values.longitude || null,
          },
          headers: authHeader,
        });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        extractFirstErrorMessage(error, 'Could not save this stop. Check your details and try again.')
      );
      return;
    }

    await this.router.navigate(['/stops']);
  }

  protected fieldError(field: 'business' | 'name'): string | null {
    const control = this.form.controls[field];
    if (!control.touched || control.valid) {
      return null;
    }
    return 'This field is required.';
  }
}
