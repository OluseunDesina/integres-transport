import { Injectable } from '@angular/core';
import type { components } from '@api-client';

import { AnalyticsEnvelopeStore, type AnalyticsQuery } from './analytics-envelope.store';

export type RevenueReport = components['schemas']['RevenueReport'];

/** `GET /analytics/revenue/` — totals, the trend series, and the three
 * breakdowns the revenue screen shows. */
@Injectable({ providedIn: 'root' })
export class RevenueStore extends AnalyticsEnvelopeStore<RevenueReport> {
  protected override fetch(query: AnalyticsQuery) {
    return this.api.GET('/api/v1/analytics/revenue/', { params: { query } });
  }

  protected override fallbackMessage(): string {
    return 'Failed to load revenue.';
  }
}
