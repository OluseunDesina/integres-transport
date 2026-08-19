import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, EmptyState, Paginator, Select, Stat, Table } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { LedgerEntryStore, type JournalEntry } from '../../shared/data/store/ledger-entry.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

type LedgerAccount = components['schemas']['LedgerAccount'];

const ALL_ACCOUNTS_OPTION: SelectOption = { value: '', label: 'All accounts' };

const ACCOUNT_TYPE_LABEL: Record<LedgerAccount['account_type'], string> = {
  wallet: 'Wallet',
  business_clearing: 'Business clearing',
  integra_commission: 'Integra commission',
  psp_suspense: 'PSP suspense',
  refund_contra: 'Refund contra',
};

const ENTRY_TYPE_LABEL: Record<JournalEntry['entry_type'], string> = {
  payment: 'Payment',
  refund: 'Refund',
  concession: 'Concession',
};

function accountLabel(account: LedgerAccount): string {
  const base = ACCOUNT_TYPE_LABEL[account.account_type];
  return account.passenger ? `${base} (${account.passenger.slice(0, 8)}…)` : base;
}

/**
 * Staff ops visibility over a Business's ledger (`ledger.view`) —
 * docs/specs/5-payments-wallet-ledger.md's client-admin frontend slice.
 *
 * Combines two data sources, both scoped to the selected Business: a
 * one-off (not `ListStore`) fetch of `GET /ledger/accounts/`, same
 * "component-local signal populated once" idiom `booking-list.ts` uses
 * for its own trip filter, which drives both the headline
 * `business_clearing` balance and the entries table's account filter —
 * and `LedgerEntryStore` for the paginated `JournalEntry` history.
 *
 * `SettlementRun` is deliberately absent from this screen — it's
 * `IsPlatformStaff`-gated only (a payout is a platform financial
 * operation, not client self-service), so client-admin has no read
 * path to it at all. `entry.settlement_run` being non-null is the only
 * signal this screen can show that a given entry has since been paid
 * out; there's nothing on the other end of that id to link to here.
 */
@Component({
  selector: 'app-ledger-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, Alert, EmptyState, Paginator, Select, Stat, Table],
  templateUrl: './ledger-overview.html',
})
export class LedgerOverview {
  protected readonly store = inject(LedgerEntryStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  protected readonly entryTypeLabel = ENTRY_TYPE_LABEL;
  protected readonly accountLabel = accountLabel;

  private readonly accounts = signal<LedgerAccount[]>([]);
  protected readonly accountsLoading = signal(false);

  protected readonly clearingAccount = computed(
    () => this.accounts().find((account) => account.account_type === 'business_clearing') ?? null
  );

  // `LedgerAccount` carries no `currency` field of its own (only
  // `PaymentIntent`/`JournalLine` do) — the Business's own currency,
  // already loaded by `SelectedBusinessStore`, is the right source for
  // labelling the headline balance.
  protected readonly businessCurrency = computed(() => {
    const businessId = this.selectedBusinessStore.selectedBusinessId();
    return this.selectedBusinessStore.items().find((business) => business.id === businessId)
      ?.currency;
  });

  protected readonly accountFilterOptions = computed<SelectOption[]>(() => [
    ALL_ACCOUNTS_OPTION,
    ...this.accounts().map((account) => ({ value: account.id, label: accountLabel(account) })),
  ]);

  private readonly accountsById = computed(
    () => new Map(this.accounts().map((account) => [account.id, account]))
  );

  // Same untracked()-wrapped effect route-list.ts documents at length —
  // fires once SelectedBusinessStore resolves an id, and on every
  // subsequent business switch. No getAll()/load() call anywhere else
  // in this class.
  private readonly syncBusinessFilter = effect(
    () => {
      const businessId = this.selectedBusinessStore.selectedBusinessId();
      if (businessId) {
        untracked(() => {
          void this.store.updateQuery({ business: businessId, account: undefined });
          void this.loadAccounts(businessId);
        });
      }
    },
    { allowSignalWrites: true }
  );

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onAccountFilterChange(value: string): void {
    void this.store.updateQuery({ account: value || undefined });
  }

  protected lineLabel(line: JournalEntry['lines'][number]): string {
    const account = this.accountsById().get(line.account);
    return account ? accountLabel(account) : `${line.account.slice(0, 8)}…`;
  }

  protected balanceHint(account: LedgerAccount): string {
    return account.cached_balance_updated_at
      ? `Updated ${new Date(account.cached_balance_updated_at).toLocaleString()}`
      : 'Not yet updated.';
  }

  private async loadAccounts(businessId: string): Promise<void> {
    this.accountsLoading.set(true);
    const { data } = await this.api.GET('/api/v1/ledger/accounts/', {
      params: { query: { business: businessId, limit: 100, offset: 0 } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    this.accounts.set(data?.results ?? []);
    this.accountsLoading.set(false);
  }
}
