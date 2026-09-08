import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import {
  Alert,
  Button,
  FormSection,
  PageHeader,
  Select,
  TextField,
  applyServerErrors,
  clearServerErrors,
  fieldErrorMessage,
} from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { RoleOptionsService } from '../role-options.service';


/**
 * Shows a success confirmation in place rather than navigating back to
 * `/staff` — spec §1's "create-only forms, no pending-invitations table"
 * decision: the invited person isn't a User yet, so an unchanged list
 * would look like nothing happened.
 */
@Component({
  selector: 'app-staff-invite',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Alert, Button, FormSection, PageHeader, Select, TextField],
  templateUrl: './staff-invite.html',
})
export class StaffInvite implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(API_CLIENT);
  private readonly roleOptionsService = inject(RoleOptionsService);
  protected readonly router = inject(Router);

  protected readonly roleOptions = signal<SelectOption[]>([]);
  protected readonly submitting = signal(false);
  protected readonly invitedEmail = signal<string | null>(null);
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
    clearServerErrors(this.form);
    this.generalError.set(null);
    const { email, role } = this.form.getRawValue();

    const { data, error } = await this.api.POST('/api/v1/staff/invitations/', {
      body: { email, role },
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
    this.form.reset({ email: '', role: this.roleOptions()[0]?.value ?? '' });
  }

  protected fieldError(field: 'email' | 'role'): string | null {
    return fieldErrorMessage(this.form.controls[field], {
      label: field === 'email' ? 'Email' : 'Role',
    });
  }
}
