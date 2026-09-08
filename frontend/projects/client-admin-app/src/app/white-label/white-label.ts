import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { Alert, Button, FormSection, PageHeader, TextField } from '@shared-ui';
import { extractFirstErrorMessage } from '../shared/error-message';
import { applyServerErrors, clearServerErrors, fieldErrorMessage } from '../shared/form-errors';

type WhiteLabelConfig = components['schemas']['WhiteLabelConfig'];
type WhiteLabelWriteFields = Omit<WhiteLabelConfig, 'id'>;

/**
 * Single-record settings form — `GET /white-label/` always returns a row
 * (backend does `get_or_create`), so unlike Business there's no create-vs-edit
 * branch: fetch on init, populate the form, PATCH on submit.
 */
@Component({
  selector: 'app-white-label',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, Alert, Button, FormSection, PageHeader, TextField],
  templateUrl: './white-label.html',
})
export class WhiteLabel implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(API_CLIENT);

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
    const { data, error } = await this.api.GET('/api/v1/white-label/', {});
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
    clearServerErrors(this.form);
    const body: WhiteLabelWriteFields = this.form.getRawValue();

    const { data, error } = await this.api.PATCH('/api/v1/white-label/', {
      body,
    });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        applyServerErrors(
          this.form,
          error,
          'Could not save these settings. Check your details and try again.'
        )
      );
      return;
    }

    this.saved.set(true);
    this.form.markAsPristine();
  }

  /** Every field, not the two that happened to have validators. The
   * previous version returned "Enter a valid email address." for the
   * *domain* field whenever it was invalid, whatever had failed. */
  protected fieldError(
    field:
      | 'domain'
      | 'logo'
      | 'primary_color'
      | 'secondary_color'
      | 'email_sender_name'
      | 'email_sender_address'
      | 'terms_url'
  ): string | null {
    return fieldErrorMessage(this.form.controls[field]);
  }
}
