import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { ListStore, type Page } from '@shared-data';

export type PaymentIntent = components['schemas']['PaymentIntent'];

export interface PaymentIntentQuery {
  business?: string;
  status?: string;
}

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load payments.';
}

/**
 * Staff ops visibility over a Business's PaymentIntent history
 * (`payments.view`) — docs/specs/5-payments-wallet-ledger.md's
 * client-admin frontend slice. Same shape as `BookingStore`: the
 * `business` query is required by the backend serializer, but left
 * optional here (mirroring the backend's own optional query param) —
 * the screen always supplies it once `SelectedBusinessStore` resolves.
 */
@Injectable({ providedIn: 'root' })
export class PaymentIntentStore extends ListStore<PaymentIntent, PaymentIntentQuery> {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: PaymentIntentQuery,
    page: Page
  ): Promise<{ items: PaymentIntent[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/payments/', {
      params: {
        query: {
          limit: page.limit,
          offset: page.offset,
          business: query.business,
          status: query.status,
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
