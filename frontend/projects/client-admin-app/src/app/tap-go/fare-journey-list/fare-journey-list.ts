import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Alert, EmptyState, Paginator, Select, StatusPill, Table } from '@shared-ui';
import type { SelectOption, StatusPillTone } from '@shared-ui';

import { FareJourneyStore, type FareJourney } from '../../shared/data/store/fare-journey.store';

type FareJourneyStatus = FareJourney['status'];

const STATUS_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'needs_review', label: 'Needs review' },
];

const STATUS_TONE: Record<FareJourneyStatus, StatusPillTone> = {
  open: 'warning',
  closed: 'positive',
  needs_review: 'negative',
};

const STATUS_LABEL: Record<FareJourneyStatus, string> = {
  open: 'Open',
  closed: 'Closed',
  needs_review: 'Needs review',
};

/**
 * Staff read-only visibility over tap-and-go activity (`tapngo.view`)
 * — closes a real UI gap: passengers could already tap in/out
 * (`validator-app`/`record-tap`) but staff had no screen to see any of
 * it. List-only, same posture `payment-list.ts` takes for its own
 * domain: no per-row action, `FareJourneyStore` has no `?business=`
 * filter to sync (see that store's own docstring for why).
 */
@Component({
  selector: 'app-fare-journey-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, Alert, EmptyState, Paginator, Select, StatusPill, Table],
  templateUrl: './fare-journey-list.html',
})
export class FareJourneyList implements OnInit {
  protected readonly store = inject(FareJourneyStore);

  protected readonly statusTone = STATUS_TONE;
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly statusFilterOptions = STATUS_FILTER_OPTIONS;

  ngOnInit(): void {
    void this.store.getAll();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onStatusFilterChange(value: string): void {
    void this.store.updateQuery({ status: value || undefined });
  }

  protected amountLabel(journey: FareJourney): string {
    return journey.amount ? `${journey.currency} ${journey.amount}` : '—';
  }
}
