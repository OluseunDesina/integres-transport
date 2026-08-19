import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Alert, EmptyState, Paginator, Select, StatusPill, Table } from '@shared-ui';
import type { SelectOption, StatusPillTone } from '@shared-ui';

import {
  PaymentIntentStore,
  type PaymentIntent,
} from '../../shared/data/store/payment-intent.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

type PaymentStatus = PaymentIntent['status'];

const STATUS_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

// Keyed on the closed status union, same idiom as booking-list.ts's own
// status map — a status added to the API fails compilation here rather
// than rendering an untranslated raw value.
const STATUS_TONE: Record<PaymentStatus, StatusPillTone> = {
  pending: 'warning',
  succeeded: 'positive',
  failed: 'negative',
  cancelled: 'neutral',
};

const STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: 'Pending',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * Staff ops visibility over a Business's PaymentIntent history
 * (`payments.view`) — docs/specs/5-payments-wallet-ledger.md's
 * client-admin frontend slice.
 *
 * Deliberately list-only, same posture `booking-list.ts` already takes
 * for its own domain: no action column (a PaymentIntent has no staff
 * action to take on it — refunds/manual intervention aren't built),
 * and `booking`/`passenger` render as truncated ids rather than chasing
 * a second lookup, since `PaymentIntent` nests neither.
 */
@Component({
  selector: 'app-payment-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, Alert, EmptyState, Paginator, Select, StatusPill, Table],
  templateUrl: './payment-list.html',
})
export class PaymentList {
  protected readonly store = inject(PaymentIntentStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);

  protected readonly statusTone = STATUS_TONE;
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly statusFilterOptions = STATUS_FILTER_OPTIONS;

  // Same untracked()-wrapped effect route-list.ts documents at length —
  // required so the write inside updateQuery() doesn't get swept into
  // this effect's own dependency tracking and retrigger itself forever.
  // No store.getAll() anywhere in this class: the effect fires the
  // first scoped fetch once SelectedBusinessStore resolves an id.
  private readonly syncBusinessFilter = effect(
    () => {
      const businessId = this.selectedBusinessStore.selectedBusinessId();
      if (businessId) {
        untracked(() => void this.store.updateQuery({ business: businessId }));
      }
    },
    { allowSignalWrites: true }
  );

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onStatusFilterChange(value: string): void {
    void this.store.updateQuery({ status: value || undefined });
  }

  protected amountLabel(payment: PaymentIntent): string {
    return `${payment.currency} ${payment.amount}`;
  }

  protected truncatedId(id: string): string {
    return `${id.slice(0, 8)}…`;
  }
}
