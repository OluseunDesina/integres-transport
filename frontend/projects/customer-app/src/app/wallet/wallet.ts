import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, EmptyState, Select, Table, TextField } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { formatMoney } from '../shared/money';

type RouteBrowse = components['schemas']['RouteBrowse'];
type Wallet = components['schemas']['Wallet'];

const PICK_BUSINESS_OPTION: SelectOption = { value: '', label: 'Select an operator' };
// Every Route the browse endpoint returns is guaranteed >=2 active
// stops (backend enforces it), so a page of routes — and the set of
// Businesses derived from it — is small and bounded; one unpaginated
// fetch is correct here, same as trip-search.ts's own MAX_OPTIONS.
const MAX_OPTIONS = 100;

function toErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return fallback;
}

/**
 * Passenger wallet — docs/specs/7-passenger-wallet.md, Slice B.
 * Closes the read-only-view gap the same session's UI sweep found
 * (`GET /wallet/mine/` had zero frontend consumers) and adds the
 * top-up flow the spec itself scopes.
 *
 * customer-app has no persistent "active Business" concept (unlike
 * client-admin-app's `SelectedBusinessStore`) — a wallet is scoped to
 * one `(business, passenger)` pair, so this screen needs a business
 * picker of its own. Sourced from `GET /routes/browse/`, exactly the
 * way `trip-search.ts` already derives its own Business-disambiguation
 * labels, deduped by `business.id` — not a new endpoint.
 */
@Component({
  selector: 'app-wallet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, Alert, Button, EmptyState, Select, Table, TextField],
  templateUrl: './wallet.html',
})
export class WalletScreen implements OnInit {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  private readonly routes = signal<RouteBrowse[]>([]);
  protected readonly routesError = signal<string | null>(null);
  protected readonly loadingRoutes = signal(false);

  protected readonly businessId = signal('');
  protected readonly wallet = signal<Wallet | null>(null);
  protected readonly loadingWallet = signal(false);
  protected readonly walletError = signal<string | null>(null);

  protected readonly topupAmount = signal('');
  protected readonly toppingUp = signal(false);
  protected readonly topupError = signal<string | null>(null);

  protected readonly businessOptions = computed<SelectOption[]>(() => {
    const seen = new Map<string, string>();
    for (const route of this.routes()) {
      seen.set(route.business.id, route.business.name);
    }
    return [
      PICK_BUSINESS_OPTION,
      ...Array.from(seen, ([value, label]) => ({ value, label })),
    ];
  });

  async ngOnInit(): Promise<void> {
    this.loadingRoutes.set(true);
    const { data, error } = await this.api.GET('/api/v1/routes/browse/', {
      params: { query: { limit: MAX_OPTIONS, offset: 0 } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    this.loadingRoutes.set(false);
    if (!data) {
      this.routesError.set(toErrorMessage(error, 'Could not load operators. Try again.'));
      return;
    }
    this.routes.set(data.results);
  }

  protected async onBusinessChange(value: string): Promise<void> {
    this.businessId.set(value);
    this.wallet.set(null);
    this.walletError.set(null);
    this.topupError.set(null);
    if (!value) {
      return;
    }

    this.loadingWallet.set(true);
    const { data, error } = await this.api.GET('/api/v1/wallet/mine/', {
      params: { query: { business: value } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    this.loadingWallet.set(false);
    if (!data) {
      this.walletError.set(toErrorMessage(error, 'Could not load your wallet. Try again.'));
      return;
    }
    this.wallet.set(data);
  }

  protected setTopupAmount(value: string): void {
    this.topupAmount.set(value);
  }

  protected balanceLabel(): string {
    const wallet = this.wallet();
    return wallet ? formatMoney(wallet.balance, wallet.currency) : '';
  }

  protected transactionLabel(transaction: Wallet['transactions'][number]): string {
    return formatMoney(transaction.amount, transaction.currency);
  }

  protected async topUp(): Promise<void> {
    const businessId = this.businessId();
    const amount = this.topupAmount();
    if (!businessId || !amount || this.toppingUp()) {
      return;
    }

    this.topupError.set(null);
    this.toppingUp.set(true);

    const { data, error } = await this.api.POST('/api/v1/payments/', {
      params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
      body: { wallet_topup: { business_id: businessId, amount } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    this.toppingUp.set(false);

    if (data?.authorization_url) {
      this.redirectToPaystack(data.authorization_url);
      return;
    }
    this.topupError.set(toErrorMessage(error, 'Could not start top-up. Try again.'));
  }

  // Isolated for testability, same seam my-bookings.ts's own
  // redirectToPaystack() already established for the identical reason.
  protected redirectToPaystack(url: string): void {
    window.location.href = url;
  }
}
