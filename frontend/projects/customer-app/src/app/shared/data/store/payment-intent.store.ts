import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { ListStore, type Page } from '@shared-data';

export type PaymentIntent = components['schemas']['PaymentIntent'];

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load your payments.';
}

/**
 * The passenger's own payment history (`GET /payments/mine/`) — mirrors
 * `BookingStore`'s own shape exactly (server-side scoping to
 * `request.user` is the whole filter). `my-bookings` stays the primary
 * "pay for a booking" entry point; this is a read history view that
 * also surfaces failed/cancelled attempts `my-bookings` doesn't show.
 */
@Injectable({ providedIn: 'root' })
export class PaymentIntentStore extends ListStore<PaymentIntent> {
  private readonly api = inject(API_CLIENT);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    _query: Record<string, never>,
    page: Page
  ): Promise<{ items: PaymentIntent[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/payments/mine/', {
      params: { query: { limit: page.limit, offset: page.offset } },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}
