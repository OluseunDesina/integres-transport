import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { Alert, EmptyState, Paginator, StatusPill, Table } from '@shared-ui';
import type { StatusPillTone } from '@shared-ui';

import { PaymentIntentStore, type PaymentIntent } from '../shared/data/store/payment-intent.store';
import { formatMoney } from '../shared/money';

type PaymentStatus = PaymentIntent['status'];

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
 * The passenger's own payment history — closes a real gap:
 * `my-bookings` only ever shows a booking's *current* status, so a
 * failed checkout attempt (the passenger's card was declined, they
 * retried and paid the second time) is invisible there. List-only, no
 * detail view: `GET /payments/{id}/` returns nothing this list row
 * doesn't already have.
 */
@Component({
  selector: 'app-payments',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, Alert, EmptyState, Paginator, StatusPill, Table],
  templateUrl: './payments.html',
})
export class Payments implements OnInit {
  protected readonly store = inject(PaymentIntentStore);

  protected readonly statusTone = STATUS_TONE;
  protected readonly statusLabel = STATUS_LABEL;

  ngOnInit(): void {
    void this.store.getAll();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected amountLabel(payment: PaymentIntent): string {
    return formatMoney(payment.amount, payment.currency);
  }
}
