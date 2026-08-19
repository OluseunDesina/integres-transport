import { ChangeDetectionStrategy, Component, signal, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, TextField } from '@shared-ui';

function fieldErrors(error: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (error && typeof error === 'object') {
    for (const [field, value] of Object.entries(error as Record<string, unknown>)) {
      if (Array.isArray(value) && typeof value[0] === 'string') {
        result[field] = value[0];
      }
    }
  }
  return result;
}

/**
 * Shows a success confirmation in place rather than navigating away —
 * same reasoning as `staff-invite.ts`: nothing to navigate back to,
 * `super-admin-app` has no client list screen, and the invited Client
 * isn't a reviewable row yet either.
 */
@Component({
  selector: 'app-client-invite',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Alert, Button, TextField],
  templateUrl: './client-invite.html',
})
export class ClientInvite {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  protected readonly submitting = signal(false);
  protected readonly invitedEmail = signal<string | null>(null);
  protected readonly nameError = signal<string | null>(null);
  protected readonly emailError = signal<string | null>(null);
  protected readonly generalError = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    name: ['', Validators.required],
    email: ['', [Validators.required, Validators.email]],
  });

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.nameError.set(null);
    this.emailError.set(null);
    this.generalError.set(null);
    const { name, email } = this.form.getRawValue();

    const { data, error } = await this.api.POST('/api/v1/super-admin/client-invitations/', {
      body: { name, email },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    this.submitting.set(false);

    if (!data) {
      const errors = fieldErrors(error);
      if (errors['name']) {
        this.nameError.set(errors['name']);
      }
      if (errors['email']) {
        this.emailError.set(errors['email']);
      }
      if (!errors['name'] && !errors['email']) {
        this.generalError.set('Could not send this invitation. Try again.');
      }
      return;
    }

    this.invitedEmail.set(email);
  }

  protected inviteAnother(): void {
    this.invitedEmail.set(null);
    this.form.reset({ name: '', email: '' });
  }

  protected nameFieldError(): string | null {
    if (this.nameError()) {
      return this.nameError();
    }
    const control = this.form.controls.name;
    if (!control.touched || control.valid) {
      return null;
    }
    return 'This field is required.';
  }

  protected emailFieldError(): string | null {
    if (this.emailError()) {
      return this.emailError();
    }
    const control = this.form.controls.email;
    if (!control.touched || control.valid) {
      return null;
    }
    if (control.hasError('required')) {
      return 'This field is required.';
    }
    if (control.hasError('email')) {
      return 'Enter a valid email address.';
    }
    return 'Invalid value.';
  }
}
