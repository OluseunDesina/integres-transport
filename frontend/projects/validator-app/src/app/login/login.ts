import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthApiService, WhiteLabelResolverService } from '@auth';
import { AuthLayout, BrandMark } from '@layout';
import { Alert, Button, TextField, fieldErrorMessage } from '@shared-ui';

@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, AuthLayout, BrandMark, Button, TextField, Alert],
  templateUrl: './login.html',
})
export class Login {
  private readonly fb = inject(FormBuilder);
  private readonly authApi = inject(AuthApiService);
  private readonly router = inject(Router);
  private readonly whiteLabel = inject(WhiteLabelResolverService);

  protected readonly subtitle = 'Sign in to record board and alight taps.';

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
      await this.router.navigate(['/record']);
    } else {
      this.errorMessage.set(result.message);
    }
  }

  // Labelled, so "Email is required." names the field rather than
  // leaving a screen-reader user to work out which of two identical
  // messages belongs to which input.
  protected fieldError(field: 'email' | 'password'): string | null {
    return fieldErrorMessage(this.form.controls[field], {
      label: field === 'email' ? 'Email' : 'Password',
    });
  }
}
