import { Injectable } from '@angular/core';
import type { components } from '@api-client';

import { AnalyticsEnvelopeStore, type AnalyticsQuery } from './analytics-envelope.store';

export type PaymentSummary = components['schemas']['PaymentSummary'];

/**
 * `GET /analytics/payments/summary/` — the metrics strip above the
 * transactions table.
 *
 * Gated on `payments.view`, not `analytics.view`: it describes exactly
 * the rows in the table beneath it, and both are narrowed by the same
 * shared filter module, so the strip and the table cannot disagree.
 */
@Injectable({ providedIn: 'root' })
export class PaymentSummaryStore extends AnalyticsEnvelopeStore<PaymentSummary> {
  protected override fetch(query: AnalyticsQuery) {
    return this.api.GET('/api/v1/analytics/payments/summary/', { params: { query } });
  }

  protected override fallbackMessage(): string {
    return 'Failed to load the payment summary.';
  }
}
