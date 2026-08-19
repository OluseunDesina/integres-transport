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
import { AuthLayout } from '@layout';
import { Alert, Button, TextField } from '@shared-ui';

function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const password = group.get('password')?.value;
  const confirmPassword = group.get('confirmPassword')?.value;
  return password === confirmPassword ? null : { passwordMismatch: true };
}

@Component({
  selector: 'app-register',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, AuthLayout, Button, TextField, Alert],
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

  protected fieldError(field: 'name' | 'email' | 'password' | 'confirmPassword'): string | null {
    const control = this.form.controls[field];
    if (!control.touched) {
      return null;
    }
    if (control.hasError('required')) {
      return 'This field is required.';
    }
    if (control.hasError('email')) {
      return 'Enter a valid email address.';
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
