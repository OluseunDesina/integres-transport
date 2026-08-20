import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { Alert, EmptyState, Paginator, StatusPill, Table } from '@shared-ui';
import type { StatusPillTone } from '@shared-ui';

import { FareJourneyStore, type FareJourney } from '../shared/data/store/fare-journey.store';
import { formatMoney } from '../shared/money';

type FareJourneyStatus = FareJourney['status'];

const STATUS_TONE: Record<FareJourneyStatus, StatusPillTone> = {
  open: 'warning',
  closed: 'positive',
  needs_review: 'negative',
};

const STATUS_LABEL: Record<FareJourneyStatus, string> = {
  open: 'In progress',
  closed: 'Complete',
  needs_review: 'Under review',
};

/**
 * The passenger's own Tap & Go ride history (`GET /fare-journeys/mine/`)
 * — closes a real gap: a passenger could already tap in/out
 * (`credential`'s own screen issues the credential that makes that
 * possible) but never saw what they were charged or when. List-only,
 * same posture `my-bookings.ts` takes: no per-row action, a journey
 * isn't something a passenger can cancel or modify.
 */
@Component({
  selector: 'app-journeys',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, Alert, EmptyState, Paginator, StatusPill, Table],
  templateUrl: './journeys.html',
})
export class Journeys implements OnInit {
  protected readonly store = inject(FareJourneyStore);

  protected readonly statusTone = STATUS_TONE;
  protected readonly statusLabel = STATUS_LABEL;

  ngOnInit(): void {
    void this.store.getAll();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected amountLabel(journey: FareJourney): string {
    return journey.amount ? formatMoney(journey.amount, journey.currency) : '—';
  }
}
