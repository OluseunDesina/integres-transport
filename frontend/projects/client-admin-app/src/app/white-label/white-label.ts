import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, TextField } from '@shared-ui';

type WhiteLabelConfig = components['schemas']['WhiteLabelConfig'];
type WhiteLabelWriteFields = Omit<WhiteLabelConfig, 'id'>;

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
 * Single-record settings form — `GET /white-label/` always returns a row
 * (backend does `get_or_create`), so unlike Business there's no create-vs-edit
 * branch: fetch on init, populate the form, PATCH on submit.
 */
@Component({
  selector: 'app-white-label',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, Alert, Button, TextField],
  templateUrl: './white-label.html',
})
export class WhiteLabel implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  protected readonly loading = signal(false);
  protected readonly loadError = signal<string | null>(null);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly saved = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    domain: ['', Validators.required],
    logo: [''],
    primary_color: [''],
    secondary_color: [''],
    email_sender_name: [''],
    email_sender_address: ['', Validators.email],
    terms_url: [''],
  });

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    const { data, error } = await this.api.GET('/api/v1/white-label/', {
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    this.loading.set(false);

    if (!data) {
      this.loadError.set(extractFirstErrorMessage(error, 'Could not load white-label settings.'));
      return;
    }

    this.form.patchValue({
      domain: data.domain,
      logo: data.logo ?? '',
      primary_color: data.primary_color ?? '',
      secondary_color: data.secondary_color ?? '',
      email_sender_name: data.email_sender_name ?? '',
      email_sender_address: data.email_sender_address ?? '',
      terms_url: data.terms_url ?? '',
    });
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    this.saved.set(false);
    const body: WhiteLabelWriteFields = this.form.getRawValue();

    const { data, error } = await this.api.PATCH('/api/v1/white-label/', {
      body,
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        extractFirstErrorMessage(error, 'Could not save these settings. Check your details and try again.')
      );
      return;
    }

    this.saved.set(true);
    this.form.markAsPristine();
  }

  protected fieldError(
    field: 'domain' | 'email_sender_address'
  ): string | null {
    const control = this.form.controls[field];
    if (!control.touched || control.valid) {
      return null;
    }
    return field === 'domain' ? 'This field is required.' : 'Enter a valid email address.';
  }
}
