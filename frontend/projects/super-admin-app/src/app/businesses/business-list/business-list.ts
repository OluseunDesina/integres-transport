import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  Alert,
  EmptyState,
  FilterBar,
  PageHeader,
  Paginator,
  StatusPill,
  Table,
} from '@shared-ui';
import type { FilterChip, StatusPillTone } from '@shared-ui';

import {
  BusinessSuperAdminStore,
  type BusinessSuperAdmin,
} from '../../shared/data/store/business-super-admin.store';

type KybStatus = BusinessSuperAdmin['kyb_status'];

const KYB_STATUS_TONE: Record<KybStatus, StatusPillTone> = {
  pending: 'neutral',
  submitted: 'warning',
  approved: 'positive',
  rejected: 'negative',
};

const KYB_STATUS_LABEL: Record<KybStatus, string> = {
  pending: 'Pending',
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected',
};

/**
 * Cross-client Business search for platform staff (`GET /super-admin/
 * businesses/`) — Phase 5 frontend Slice C, the entry point for the
 * other two new screens (Paystack config, settlement runs), neither of
 * which had any way to find a Business before this one existed:
 * `GET /businesses/` is Client-scoped, and the KYB queue drops a
 * Business the moment it's approved.
 *
 * Search is now live-as-you-type through `ui-filter-bar`, which owns the
 * debounce. It was submit-triggered before, for the reason this
 * docstring used to record — no debounce utility existed anywhere in the
 * workspace, and an undebounced box would have meant one cross-client
 * query per keystroke. `docs/specs/14`'s primitive supplies it, so the
 * extra Search button is gone.
 *
 * The active search also renders as a chip. A cross-client list showing
 * a filtered subset with nothing on screen saying so is indistinguishable
 * from a list with no data — which is the same confusion this screen's
 * own "Business not found" bug came from during Phase 5.
 */
@Component({
  selector: 'app-business-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    Alert,
    EmptyState,
    FilterBar,
    PageHeader,
    Paginator,
    StatusPill,
    Table,
  ],
  templateUrl: './business-list.html',
})
export class BusinessList implements OnInit {
  protected readonly store = inject(BusinessSuperAdminStore);

  protected readonly statusTone = KYB_STATUS_TONE;
  protected readonly statusLabel = KYB_STATUS_LABEL;
  protected readonly searchTerm = signal('');

  protected readonly chips = computed<FilterChip[]>(() => {
    const term = this.searchTerm().trim();
    return term ? [{ id: 'search', label: 'Name', value: term }] : [];
  });

  ngOnInit(): void {
    void this.store.getAll();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onSearchTermChange(value: string): void {
    // Stored raw, trimmed only on the way into the query and the chip.
    // `searchValue` feeds the input's own `[value]`, so writing a trimmed
    // string back would delete a trailing space the moment the user typed
    // one and jump their cursor.
    this.searchTerm.set(value);
    // `updateQuery` resets to the first page, which is what a changed
    // filter should do — staying on page 4 of a narrower result set is
    // how "no businesses found" gets shown for a search that matched.
    void this.store.updateQuery({ search: value.trim() || undefined });
  }

  protected onClearSearch(): void {
    this.onSearchTermChange('');
  }
}
