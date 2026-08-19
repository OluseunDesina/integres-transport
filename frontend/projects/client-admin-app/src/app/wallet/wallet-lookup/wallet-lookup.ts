import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, EmptyState, Stat, Table, TextField } from '@shared-ui';

import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

type Wallet = components['schemas']['Wallet'];

function extractFirstErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
    for (const value of Object.values(error as Record<string, unknown>)) {
      if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0];
      }
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  return fallback;
}

/**
 * Staff support/dispute tool: look up one passenger's wallet balance
 * and transaction history for the selected business (`wallet.view`) —
 * docs/specs/5-payments-wallet-ledger.md's client-admin frontend slice.
 *
 * A real, reactive form (not the template-driven filter-`ui-select`
 * idiom the other two screens in this slice use) since this is an
 * actual submission, not a live list filter — matches this repo's
 * "reactive forms only" convention for forms, same as `business-form.ts`.
 *
 * **Named limitation**: `GET /wallet/?business=&passenger=` requires
 * the passenger's UUID directly — there is no search-by-name/email on
 * the backend today, so staff must already have the id in hand (e.g.
 * from a support ticket). Not solved here; a real fix needs a new
 * backend lookup capability, out of scope for this read-only slice.
 */
@Component({
  selector: 'app-wallet-lookup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ReactiveFormsModule, Alert, Button, EmptyState, Stat, Table, TextField],
  templateUrl: './wallet-lookup.html',
})
export class WalletLookup {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  protected readonly selectedBusinessStore = inject(SelectedBusinessStore);

  protected readonly form = this.fb.nonNullable.group({
    passengerId: ['', Validators.required],
  });

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly wallet = signal<Wallet | null>(null);
  protected readonly searchedPassengerId = signal<string | null>(null);

  protected async onSubmit(): Promise<void> {
    const businessId = this.selectedBusinessStore.selectedBusinessId();
    if (this.form.invalid || !businessId) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    this.wallet.set(null);
    const passengerId = this.form.getRawValue().passengerId;

    const { data, error } = await this.api.GET('/api/v1/wallet/', {
      params: { query: { business: businessId, passenger: passengerId } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        extractFirstErrorMessage(error, 'Could not find a wallet for that passenger.')
      );
      return;
    }

    this.wallet.set(data);
    this.searchedPassengerId.set(passengerId);
  }

  protected fieldError(): string | null {
    const control = this.form.controls.passengerId;
    if (!control.touched || control.valid) {
      return null;
    }
    return 'Enter the passenger’s id.';
  }
}
