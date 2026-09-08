import { ChangeDetectionStrategy, Component, signal, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import {
  Alert,
  Button,
  FormSection,
  PageHeader,
  TextField,
  applyServerErrors,
  clearServerErrors,
  fieldErrorMessage,
} from '@shared-ui';

/**
 * Shows a success confirmation in place rather than navigating away —
 * same reasoning as `staff-invite.ts`: nothing to navigate back to,
 * `super-admin-app` has no client list screen, and the invited Client
 * isn't a reviewable row yet either.
 *
 * Its private `fieldErrors` helper, two per-field error signals and two
 * hand-written `fieldError` methods are gone (spec 14 slice 6a) in
 * favour of `@shared-ui`'s `form-errors`. The name field's own copy was
 * one of the twelve that returned "This field is required." for any
 * failure whatever had actually gone wrong.
 */
@Component({
  selector: 'app-client-invite',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Alert, Button, FormSection, PageHeader, TextField],
  templateUrl: './client-invite.html',
})
export class ClientInvite {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(API_CLIENT);

  protected readonly submitting = signal(false);
  protected readonly invitedEmail = signal<string | null>(null);
  protected readonly generalError = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    name: ['', Validators.required],
    email: ['', [Validators.required, Validators.email]],
  });

  protected fieldError(field: 'name' | 'email'): string | null {
    return fieldErrorMessage(this.form.controls[field], {
      label: field === 'name' ? 'Business name' : 'Email',
    });
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.generalError.set(null);
    clearServerErrors(this.form);
    const { name, email } = this.form.getRawValue();

    const { data, error } = await this.api.POST('/api/v1/super-admin/client-invitations/', {
      body: { name, email },
    });

    this.submitting.set(false);

    if (!data) {
      this.generalError.set(
        applyServerErrors(this.form, error, 'Could not send this invitation. Try again.')
      );
      return;
    }

    this.invitedEmail.set(email);
  }

  protected inviteAnother(): void {
    this.invitedEmail.set(null);
    this.generalError.set(null);
    clearServerErrors(this.form);
    this.form.reset({ name: '', email: '' });
  }
}
