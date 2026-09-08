import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { Alert, Button, EmptyState, Stat, Table, TextField, PageHeader } from '@shared-ui';

import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

type Wallet = components['schemas']['Wallet'];
type Passenger = components['schemas']['Passenger'];

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
 * **The limitation this screen shipped with is gone.**
 * `GET /wallet/?business=&passenger=` still takes a UUID, and there was
 * no way to obtain one — so this screen only worked if a support ticket
 * happened to quote the id, which is to say it mostly did not.
 * `GET /passengers/lookup/` (spec 18 slice 2) is that missing
 * capability: the agent types the address the passenger gives them, and
 * the id is resolved behind the form.
 *
 * The endpoint accepts `wallet.view` as well as `booking.manage` for
 * exactly this reason. Gating it on `booking.manage` alone — which is
 * what its own spec proposed — would have left this screen broken for
 * every Staff user, who hold `wallet.view` and deliberately not the
 * other. The recorded rule: check a gating codename is reachable before
 * building a control that needs it.
 */
@Component({
  selector: 'app-wallet-lookup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    ReactiveFormsModule,
    Alert,
    Button,
    EmptyState,
    PageHeader,
    Stat,
    Table,
    TextField,
  ],
  templateUrl: './wallet-lookup.html',
})
export class WalletLookup {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(API_CLIENT);
  protected readonly selectedBusinessStore = inject(SelectedBusinessStore);

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly notFound = signal(false);
  protected readonly wallet = signal<Wallet | null>(null);
  protected readonly passenger = signal<Passenger | null>(null);

  protected async onSubmit(): Promise<void> {
    const businessId = this.selectedBusinessStore.selectedBusinessId();
    if (this.form.invalid || !businessId) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    this.notFound.set(false);
    this.wallet.set(null);
    this.passenger.set(null);

    // Two calls, in order: resolve the person, then read their wallet.
    // The id never appears in the form — an agent has no reason to see
    // a UUID, and typing one was the whole problem.
    const lookup = await this.api.GET('/api/v1/passengers/lookup/', {
      params: { query: { email: this.form.getRawValue().email } },
    });

    if (!lookup.data) {
      this.submitting.set(false);
      if (lookup.response?.status === 404) {
        // Not an error box: "no account uses that address" is an
        // ordinary answer, and it tells the agent something useful.
        this.notFound.set(true);
        return;
      }
      this.errorMessage.set(
        extractFirstErrorMessage(lookup.error, 'Could not look that passenger up.')
      );
      return;
    }

    const { data, error } = await this.api.GET('/api/v1/wallet/', {
      params: { query: { business: businessId, passenger: lookup.data.id } },
    });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        extractFirstErrorMessage(error, 'Could not find a wallet for that passenger.')
      );
      return;
    }

    this.wallet.set(data);
    this.passenger.set(lookup.data);
  }

  protected fieldError(): string | null {
    const control = this.form.controls.email;
    if (!control.touched || control.valid) {
      return null;
    }
    return control.hasError('required')
      ? 'Enter the passenger’s email address.'
      : 'Enter a complete email address.';
  }
}
