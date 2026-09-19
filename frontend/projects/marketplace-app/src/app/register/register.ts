import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthApiService } from '@auth';
import { Alert, Button, TextField, fieldErrorMessage } from '@shared-ui';

import { MarketplaceAuthLayout } from '../shared/marketplace-auth-layout';
import { readPendingBooking } from '../shared/booking-draft';

/**
 * Passenger self-registration — docs/specs/22-marketplace.md. The
 * first sign-up path on the platform (no passenger self-registration
 * exists anywhere else today); creates the account and signs the
 * passenger straight in, matching `apps.clients.views
 * .ClientRegistrationView`'s own "register, then already-authenticated"
 * shape rather than a separate verify-then-sign-in step.
 *
 * Slice 2 (guest browsing): a guest sent here from `seat-picker`'s
 * "Book now" carries a `pendingBooking` in router state, forwarded on
 * to `/book` on success instead of the default `/search` — see
 * `login.ts`'s identical handling and `booking-draft.ts`'s
 * `readPendingBooking()`.
 */
@Component({
  selector: 'app-register',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MarketplaceAuthLayout, Button, TextField, Alert],
  templateUrl: './register.html',
})
export class Register {
  private readonly fb = inject(FormBuilder);
  private readonly authApi = inject(AuthApiService);
  private readonly router = inject(Router);

  protected readonly form = this.fb.nonNullable.group({
    firstName: ['', Validators.required],
    lastName: [''],
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
    const { firstName, lastName, email, password } = this.form.getRawValue();
    const result = await this.authApi.registerCustomer(email, password, firstName, lastName);
    this.submitting.set(false);

    if (result.ok) {
      const pendingBooking = readPendingBooking(this.router);
      if (pendingBooking) {
        await this.router.navigate(['/book'], { state: pendingBooking });
        return;
      }
      await this.router.navigate(['/search']);
    } else {
      this.errorMessage.set(result.message);
    }
  }

  protected fieldError(field: 'firstName' | 'email' | 'password'): string | null {
    const labels = { firstName: 'First name', email: 'Email', password: 'Password' };
    return fieldErrorMessage(this.form.controls[field], { label: labels[field] });
  }
}
