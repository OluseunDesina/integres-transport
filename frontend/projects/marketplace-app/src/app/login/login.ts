import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthApiService } from '@auth';
import { Alert, Button, TextField, fieldErrorMessage } from '@shared-ui';

import { MarketplaceAuthLayout } from '../shared/marketplace-auth-layout';
import { readPendingBooking } from '../shared/booking-draft';

/**
 * Sign in — docs/specs/22-marketplace.md. Unlike `customer-app`'s own
 * login, there is no `client` disambiguation field: this app has no
 * white-label subdomain to resolve a Client from, and a marketplace
 * passenger's email is virtually always unique to the one Marketplace
 * Client they registered under. The rare case — the same email also
 * exists as some operator's own passenger — surfaces as a clear
 * "multiple accounts" error rather than silently picking one; adding a
 * disambiguation field for that edge case is deferred, not silently
 * dropped.
 *
 * Slice 2 (guest browsing): a guest sent here from `seat-picker`'s
 * "Book now" carries a `pendingBooking` in router state, forwarded on
 * to `/book` on success instead of the default `/search` — see
 * `booking-draft.ts`'s `readPendingBooking()`.
 */
@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MarketplaceAuthLayout, Button, TextField, Alert],
  templateUrl: './login.html',
})
export class Login {
  private readonly fb = inject(FormBuilder);
  private readonly authApi = inject(AuthApiService);
  private readonly router = inject(Router);

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
    const result = await this.authApi.login(email, password);
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

  protected fieldError(field: 'email' | 'password'): string | null {
    return fieldErrorMessage(this.form.controls[field], {
      label: field === 'email' ? 'Email' : 'Password',
    });
  }
}
