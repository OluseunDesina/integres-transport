import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { ListStore, type Page } from '@shared-data';

export type JournalEntry = components['schemas']['JournalEntry'];

export interface LedgerEntryQuery {
  business?: string;
  account?: string;
}

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load ledger entries.';
}

/**
 * Staff ops visibility over a Business's JournalEntry history
 * (`ledger.view`) — docs/specs/5-payments-wallet-ledger.md's
 * client-admin frontend slice. `business` is a required backend query
 * param (unlike `PaymentIntentStore`'s optional one) — the screen never
 * calls `getAll()` until `SelectedBusinessStore` resolves an id, same
 * guard `route-list.ts` already documents for its own required param.
 */
@Injectable({ providedIn: 'root' })
export class LedgerEntryStore extends ListStore<JournalEntry, LedgerEntryQuery> {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: LedgerEntryQuery,
    page: Page
  ): Promise<{ items: JournalEntry[]; total: number }> {
    if (!query.business) {
      return { items: [], total: 0 };
    }
    const { data, error } = await this.api.GET('/api/v1/ledger/entries/', {
      params: {
        query: {
          limit: page.limit,
          offset: page.offset,
          business: query.business,
          account: query.account,
        },
      },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}
