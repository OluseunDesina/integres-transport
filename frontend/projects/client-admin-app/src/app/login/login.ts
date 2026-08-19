import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthApiService, WhiteLabelResolverService } from '@auth';
import { AuthLayout } from '@layout';
import { Alert, Button, TextField } from '@shared-ui';

@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, AuthLayout, Button, TextField, Alert],
  templateUrl: './login.html',
})
export class Login {
  private readonly fb = inject(FormBuilder);
  private readonly authApi = inject(AuthApiService);
  private readonly router = inject(Router);
  private readonly whiteLabel = inject(WhiteLabelResolverService);

  protected readonly subtitle = 'Sign in to manage your fleet, routes and bookings.';

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', Validators.required],
  });

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    const { email, password } = this.form.getRawValue();
    const result = await this.authApi.login(email, password, this.whiteLabel.clientId() ?? undefined);
    this.submitting.set(false);

    if (result.ok) {
      await this.router.navigate(['/home']);
    } else {
      this.errorMessage.set(result.message);
    }
  }

  protected fieldError(field: 'email' | 'password'): string | null {
    const control = this.form.controls[field];
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
