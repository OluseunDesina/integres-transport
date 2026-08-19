import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, Select, TextField } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { RoleOptionsService } from '../role-options.service';

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
 * Shows a success confirmation in place rather than navigating back to
 * `/staff` — spec §1's "create-only forms, no pending-invitations table"
 * decision: the invited person isn't a User yet, so an unchanged list
 * would look like nothing happened.
 */
@Component({
  selector: 'app-staff-invite',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Alert, Button, Select, TextField],
  templateUrl: './staff-invite.html',
})
export class StaffInvite implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly roleOptionsService = inject(RoleOptionsService);
  protected readonly router = inject(Router);

  protected readonly roleOptions = signal<SelectOption[]>([]);
  protected readonly submitting = signal(false);
  protected readonly invitedEmail = signal<string | null>(null);
  protected readonly emailError = signal<string | null>(null);
  protected readonly roleError = signal<string | null>(null);
  protected readonly generalError = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    role: ['', Validators.required],
  });

  async ngOnInit(): Promise<void> {
    try {
      const options = await this.roleOptionsService.loadOptions();
      this.roleOptions.set(options);
      const defaultRole = options[0]?.value;
      if (defaultRole) {
        this.form.controls.role.setValue(defaultRole);
      }
    } catch {
      this.generalError.set('Could not load roles. Try reloading the page.');
    }
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.emailError.set(null);
    this.roleError.set(null);
    this.generalError.set(null);
    const { email, role } = this.form.getRawValue();

    const { data, error } = await this.api.POST('/api/v1/staff/invitations/', {
      body: { email, role },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    this.submitting.set(false);

    if (!data) {
      const errors = fieldErrors(error);
      if (errors['email']) {
        this.emailError.set(errors['email']);
      }
      if (errors['role']) {
        this.roleError.set(errors['role']);
      }
      if (!errors['email'] && !errors['role']) {
        this.generalError.set('Could not send this invitation. Try again.');
      }
      return;
    }

    this.invitedEmail.set(email);
  }

  protected inviteAnother(): void {
    this.invitedEmail.set(null);
    this.form.reset({ email: '', role: this.roleOptions()[0]?.value ?? '' });
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

  protected roleFieldError(): string | null {
    if (this.roleError()) {
      return this.roleError();
    }
    const control = this.form.controls.role;
    if (!control.touched || control.valid) {
      return null;
    }
    return 'This field is required.';
  }
}
