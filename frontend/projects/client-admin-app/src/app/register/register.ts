import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthApiService } from '@auth';
import { AuthLayout, BrandMark } from '@layout';
import { Alert, Button, TextField, fieldErrorMessage } from '@shared-ui';

function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const password = group.get('password')?.value;
  const confirmPassword = group.get('confirmPassword')?.value;
  return password === confirmPassword ? null : { passwordMismatch: true };
}

const LABELS: Record<'name' | 'email' | 'password' | 'confirmPassword', string> = {
  name: 'Business name',
  email: 'Email',
  password: 'Password',
  confirmPassword: 'Confirm password',
};

@Component({
  selector: 'app-register',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, AuthLayout, BrandMark, Button, TextField, Alert],
  templateUrl: './register.html',
})
export class Register {
  private readonly fb = inject(FormBuilder);
  private readonly authApi = inject(AuthApiService);
  private readonly router = inject(Router);

  protected readonly subtitle = 'Register your business to start managing routes and bookings.';

  protected readonly form = this.fb.nonNullable.group(
    {
      name: ['', Validators.required],
      email: ['', [Validators.required, Validators.email]],
      phone: [''],
      password: ['', Validators.required],
      confirmPassword: ['', Validators.required],
    },
    { validators: passwordsMatch }
  );

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    const { name, email, phone, password } = this.form.getRawValue();
    const result = await this.authApi.register(name, email, phone, password);
    this.submitting.set(false);

    if (result.ok) {
      await this.router.navigate(['/home']);
    } else {
      this.errorMessage.set(result.message);
    }
  }

  /**
   * `passwordMismatch` is a **form-level** error, and
   * `fieldErrorMessage` reads control-level errors only — so it has to
   * be checked here or it disappears silently. It is the one message
   * this migration could have lost.
   *
   * Control errors still win: an empty confirmation reads as missing
   * rather than as mismatched, which is the more useful of the two.
   */
  protected fieldError(field: 'name' | 'email' | 'password' | 'confirmPassword'): string | null {
    const control = this.form.controls[field];
    const message = fieldErrorMessage(control, { label: LABELS[field] });
    if (message) {
      return message;
    }
    if (field === 'confirmPassword' && control.touched && this.form.hasError('passwordMismatch')) {
      return 'Passwords do not match.';
    }
    return null;
  }
}
