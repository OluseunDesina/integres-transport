import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthApiService } from '@auth';
import { AuthLayout } from '@layout';
import { Alert, Button, TextField } from '@shared-ui';

function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const password = group.get('password')?.value;
  const confirmPassword = group.get('confirmPassword')?.value;
  return password === confirmPassword ? null : { passwordMismatch: true };
}

const STATUS_MESSAGES: Record<string, string> = {
  accepted: 'This invitation has already been accepted.',
  revoked: 'This invitation has been revoked.',
  expired: 'This invitation has expired.',
};

/**
 * Public route, resolved by `:token` — accepts a client-admin-sent
 * `apps.identity.models.StaffInvitation`. Same shape as
 * `client-invite-accept.ts` (no `phone` field here — a staff member's
 * `User` row doesn't collect one at invite-acceptance time) calling
 * `AuthApiService.acceptStaffInvitation()` instead.
 *
 * Closes the same class of dead end: `staff-invite.ts` could already
 * send this invitation, but nothing anywhere resolved the token it
 * produces — the invited staff member had no page to land on.
 */
@Component({
  selector: 'app-staff-invite-accept',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, AuthLayout, Button, TextField, Alert],
  templateUrl: './staff-invite-accept.html',
})
export class StaffInviteAccept implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly authApi = inject(AuthApiService);

  private readonly token = this.route.snapshot.paramMap.get('token') ?? '';

  protected readonly loading = signal(true);
  protected readonly clientName = signal<string | null>(null);
  protected readonly roleName = signal<string | null>(null);
  protected readonly invalidMessage = signal<string | null>(null);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group(
    {
      password: ['', Validators.required],
      confirmPassword: ['', Validators.required],
    },
    { validators: passwordsMatch }
  );

  async ngOnInit(): Promise<void> {
    const { data, error } = await this.api.GET('/api/v1/staff/invitations/{token}/', {
      params: { path: { token: this.token } },
    });
    this.loading.set(false);

    if (!data) {
      this.invalidMessage.set(
        (error as { detail?: string } | undefined)?.detail ?? 'This invitation could not be found.'
      );
      return;
    }
    if (data.status !== 'pending') {
      this.invalidMessage.set(STATUS_MESSAGES[data.status] ?? 'This invitation is no longer valid.');
      return;
    }
    this.clientName.set(data.client_name);
    this.roleName.set(data.role_name);
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    const { password } = this.form.getRawValue();
    const result = await this.authApi.acceptStaffInvitation(this.token, password);
    this.submitting.set(false);

    if (result.ok) {
      await this.router.navigate(['/home']);
    } else {
      this.errorMessage.set(result.message);
    }
  }

  protected fieldError(field: 'password' | 'confirmPassword'): string | null {
    const control = this.form.controls[field];
    if (!control.touched) {
      return null;
    }
    if (control.hasError('required')) {
      return 'This field is required.';
    }
    if (field === 'confirmPassword' && this.form.hasError('passwordMismatch')) {
      return 'Passwords do not match.';
    }
    if (!control.valid) {
      return 'Invalid value.';
    }
    return null;
  }
}
