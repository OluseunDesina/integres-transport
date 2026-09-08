import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import {
  Alert,
  Button,
  EmptyState,
  FormSection,
  PageHeader,
  Select,
  Skeleton,
  Stat,
  Table,
  TextField,
  applyServerErrors,
  clearServerErrors,
  fieldErrorMessage,
} from '@shared-ui';
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

/**
 * A decimal amount, optionally with up to two places, and greater than
 * zero.
 *
 * `Validators.min` alone is not enough, because the control's value is a
 * string: `Number('')` is 0 and `Number('abc')` is NaN, and `NaN >= 0.01`
 * is false in a way that produces the *right* answer for the wrong
 * reason. Matching the shape first means the min check only ever sees a
 * real number.
 */
const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

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
 *
 * **The top-up amount is a validated reactive control** as of spec 14
 * slice 5. It was a bare string signal whose only gate was "not empty",
 * so `abc`, `-5` and `0` all reached `POST /payments/` and came back as
 * whatever DRF said — and the field offered a phone a full QWERTY
 * keyboard to type a sum of money.
 */
@Component({
  selector: 'app-wallet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    ReactiveFormsModule,
    Alert,
    Button,
    EmptyState,
    FormSection,
    PageHeader,
    Select,
    Skeleton,
    Stat,
    Table,
    TextField,
  ],
  templateUrl: './wallet.html',
})
export class WalletScreen implements OnInit {
  private readonly api = inject(API_CLIENT);
  private readonly fb = inject(FormBuilder);

  private readonly routes = signal<RouteBrowse[]>([]);
  protected readonly routesError = signal<string | null>(null);
  protected readonly loadingRoutes = signal(false);

  protected readonly businessId = signal('');
  protected readonly wallet = signal<Wallet | null>(null);
  protected readonly loadingWallet = signal(false);
  protected readonly walletError = signal<string | null>(null);

  protected readonly topupForm = this.fb.nonNullable.group({
    amount: ['', [Validators.required, Validators.pattern(AMOUNT_PATTERN), Validators.min(0.01)]],
  });

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
    });
    this.loadingWallet.set(false);
    if (!data) {
      this.walletError.set(toErrorMessage(error, 'Could not load your wallet. Try again.'));
      return;
    }
    this.wallet.set(data);
  }

  protected amountError(): string | null {
    return fieldErrorMessage(this.topupForm.controls.amount, {
      messages: {
        // The generic wordings are wrong here in both directions: a
        // "pattern" failure is not a format the passenger can be
        // expected to infer, and "Enter 0.01 or more." is a strange
        // thing to say about money.
        pattern: 'Enter an amount like 1500 or 1500.50.',
        min: 'Enter an amount greater than zero.',
      },
    });
  }

  protected balanceLabel(): string {
    const wallet = this.wallet();
    return wallet ? formatMoney(wallet.balance, wallet.currency) : '';
  }

  protected transactionLabel(transaction: Wallet['transactions'][number]): string {
    return formatMoney(transaction.amount, transaction.currency);
  }

  protected async topUp(): Promise<void> {
    if (this.toppingUp()) {
      return;
    }
    if (this.topupForm.invalid) {
      this.topupForm.markAllAsTouched();
      return;
    }

    const businessId = this.businessId();
    if (!businessId) {
      return;
    }

    clearServerErrors(this.topupForm);
    this.topupError.set(null);
    this.toppingUp.set(true);

    const { data, error } = await this.api.POST('/api/v1/payments/', {
      params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
      // use_wallet_balance is only meaningful alongside booking_id
      // (the server rejects it paired with wallet_topup) — included
      // as false here only because the generated type isn't optional
      // for a field with a schema-level default.
      body: {
        use_wallet_balance: false,
        wallet_topup: { business_id: businessId, amount: this.topupForm.controls.amount.value },
      },
    });

    this.toppingUp.set(false);

    if (data?.authorization_url) {
      this.redirectToPaystack(data.authorization_url);
      return;
    }
    // `wallet_topup.amount` is a real field the server can reject, so
    // its message belongs under the field rather than flattened into
    // the page-level alert the way every error here used to be.
    this.topupError.set(
      applyServerErrors(this.topupForm, unwrapTopupError(error), 'Could not start top-up. Try again.')
    );
  }

  // Isolated for testability, same seam my-bookings.ts's own
  // redirectToPaystack() already established for the identical reason.
  protected redirectToPaystack(url: string): void {
    window.location.href = url;
  }
}

/**
 * Lifts `{wallet_topup: {amount: [...]}}` up one level so the `amount`
 * key matches this form's control name.
 *
 * The request nests the amount inside `wallet_topup`, so DRF nests the
 * error the same way — and `applyServerErrors` matches on top-level
 * keys, correctly: a helper that walked arbitrarily deep would start
 * guessing which control a nested name meant. Unwrapping the one shape
 * this screen actually sends is the honest version. Anything else in the
 * body passes through untouched and still reaches the page alert.
 */
function unwrapTopupError(error: unknown): unknown {
  if (!error || typeof error !== 'object') {
    return error;
  }
  const body = error as Record<string, unknown>;
  const nested = body['wallet_topup'];
  if (!nested || typeof nested !== 'object') {
    return error;
  }
  const rest = { ...body };
  delete rest['wallet_topup'];
  return { ...rest, ...(nested as Record<string, unknown>) };
}
