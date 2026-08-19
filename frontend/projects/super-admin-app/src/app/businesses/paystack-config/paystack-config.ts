import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, TextField } from '@shared-ui';

import {
  BusinessSuperAdminStore,
  type BusinessSuperAdmin,
} from '../../shared/data/store/business-super-admin.store';

function extractFirstErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
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
 * Configure a Business's Paystack payout destination
 * (`GET`/`PATCH /super-admin/businesses/{id}/paystack-account/`) —
 * Phase 5 frontend Slice C. The GET is new this slice: without it, this
 * screen would be a blind overwrite with no way to tell whether a
 * Business is already configured. A 404 on load is an expected "not
 * yet configured" state, not an error — the form still renders, just
 * blank.
 *
 * **Named limitation**: `recipient_code` is a plain text field. There
 * is no Paystack "resolve account number → recipient_code" call
 * anywhere in this codebase (`psp/paystack.py` only has
 * `initialize_transaction`/`initiate_transfer`/`verify_webhook_signature`)
 * — staff paste in a code obtained outside this app (e.g. Paystack's
 * own dashboard). A real verify step needs a new Paystack integration,
 * out of scope here.
 */
@Component({
  selector: 'app-paystack-config',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Alert, Button, TextField],
  templateUrl: './paystack-config.html',
})
export class PaystackConfig implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly businessStore = inject(BusinessSuperAdminStore);

  protected readonly businessId = signal('');
  protected readonly business = signal<BusinessSuperAdmin | null>(null);
  protected readonly notFound = signal(false);
  protected readonly loading = signal(true);
  protected readonly submitting = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly successMessage = signal<string | null>(null);
  protected readonly alreadyConfigured = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    bank_code: [''],
    account_number: [''],
    account_name: [''],
    recipient_code: ['', Validators.required],
    is_active: [true],
  });

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      return;
    }
    this.businessId.set(id);

    const business = await this.businessStore.findById(id);
    if (!business) {
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    this.business.set(business);

    const { data, error, response } = await this.api.GET(
      '/api/v1/super-admin/businesses/{id}/paystack-account/',
      {
        params: { path: { id } },
        headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
      }
    );

    if (data) {
      this.alreadyConfigured.set(true);
      this.form.patchValue(data);
    } else if (response.status !== 404) {
      this.loadError.set(
        extractFirstErrorMessage(error, 'Could not load the current Paystack configuration.')
      );
    }
    this.loading.set(false);
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.successMessage.set(null);
    this.loadError.set(null);

    const { data, error } = await this.api.PATCH(
      '/api/v1/super-admin/businesses/{id}/paystack-account/',
      {
        params: { path: { id: this.businessId() } },
        body: this.form.getRawValue(),
        headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
      }
    );

    this.submitting.set(false);

    if (!data) {
      this.loadError.set(
        extractFirstErrorMessage(error, 'Could not save this Paystack configuration.')
      );
      return;
    }

    this.alreadyConfigured.set(true);
    this.successMessage.set('Paystack account saved.');
    this.form.patchValue(data);
  }
}
