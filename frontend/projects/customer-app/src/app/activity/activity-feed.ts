import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, effect, inject } from '@angular/core';
import { Poller } from '@shared-data';
import { Alert, EmptyState, PageHeader, Skeleton } from '@shared-ui';

import { ActivityStore, type ActivityEntry } from '../shared/data/store/activity.store';
import { formatMoney } from '../shared/money';

type ActivityType = ActivityEntry['type'];

const TYPE_LABEL: Record<ActivityType, string> = {
  wallet_topup: 'Wallet top-up',
  booking_paid: 'Booking paid',
  ticket_boarded: 'Boarded',
  fare_deducted: 'Fare',
};

/**
 * The passenger's own recent activity — docs/specs/20-live-operations.md
 * slice 4's "real-time activity feed", honestly implemented: it is
 * near-real-time, its latency is the poll interval, and nothing on this
 * screen claims otherwise.
 *
 * Reachable from a `home` quick-link card, not the top nav bar —
 * `app-shell.ts`'s own comment records that bar as already at its
 * measured width budget for 1200px, and adding an eighth link risks
 * re-breaking it for no reason a card can't solve just as well.
 *
 * Each row's `amount`/`wallet_balance` can genuinely be absent
 * (`ticket_boarded` has neither, and a card-paid `booking_paid` has no
 * `wallet_balance`) — see `apps.activity.services`' own docstring for
 * why, and `amountLabel`/`balanceLabel` below render that as words,
 * never a blank cell or an invented zero.
 */
@Component({
  selector: 'app-activity-feed',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, Alert, EmptyState, PageHeader, Skeleton],
  templateUrl: './activity-feed.html',
})
export class ActivityFeed implements OnInit, OnDestroy {
  protected readonly store = inject(ActivityStore);

  protected readonly typeLabel = TYPE_LABEL;

  private readonly poller = new Poller(() => this.store.poll(), 30_000);

  constructor() {
    effect(() => {
      this.poller.setIntervalMs(this.store.pollIntervalSeconds() * 1000);
    });
  }

  ngOnInit(): void {
    this.poller.start();
  }

  ngOnDestroy(): void {
    this.poller.destroy();
  }

  protected title(entry: ActivityEntry): string {
    const label = this.typeLabel[entry.type];
    return entry.route ? `${label} — ${entry.route}` : label;
  }

  protected amountLabel(entry: ActivityEntry): string {
    if (entry.amount === null || entry.currency === null) {
      return '';
    }
    // `fare_deducted` already carries its own "-" from the service
    // layer (a deduction); every other type is a plain positive amount.
    // The row's own title already says which direction the money moved
    // in words, so no extra +/- convention is layered on top of it.
    return formatMoney(entry.amount, entry.currency);
  }

  protected balanceLabel(entry: ActivityEntry): string {
    if (entry.wallet_balance === null || entry.currency === null) {
      return '';
    }
    return `Wallet balance: ${formatMoney(entry.wallet_balance, entry.currency)}`;
  }
}
