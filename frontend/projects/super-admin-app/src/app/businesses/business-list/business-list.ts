import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Alert, Button, EmptyState, Paginator, StatusPill, Table, TextField } from '@shared-ui';
import type { StatusPillTone } from '@shared-ui';

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
 * Search is submit-triggered, not live-as-you-type — no debounce
 * utility exists anywhere in this workspace yet, and every other
 * search-adjacent screen here (`kyb-queue`/`kyc-queue`) has no free-text
 * filter to compare against.
 */
@Component({
  selector: 'app-business-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    Alert,
    Button,
    EmptyState,
    Paginator,
    StatusPill,
    Table,
    TextField,
  ],
  templateUrl: './business-list.html',
})
export class BusinessList implements OnInit {
  protected readonly store = inject(BusinessSuperAdminStore);

  protected readonly statusTone = KYB_STATUS_TONE;
  protected readonly statusLabel = KYB_STATUS_LABEL;
  protected readonly searchTerm = signal('');

  ngOnInit(): void {
    void this.store.getAll();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onSearchTermChange(value: string): void {
    this.searchTerm.set(value);
  }

  protected onSearchSubmit(): void {
    void this.store.updateQuery({ search: this.searchTerm().trim() || undefined });
  }
}
