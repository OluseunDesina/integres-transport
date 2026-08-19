import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, EmptyState, Paginator, StatusPill, Table, TextField } from '@shared-ui';
import type { StatusPillTone } from '@shared-ui';

import {
  BusinessSuperAdminStore,
  type BusinessSuperAdmin,
} from '../../shared/data/store/business-super-admin.store';
import { SettlementRunStore, type SettlementRun } from '../../shared/data/store/settlement-run.store';

type RunStatus = SettlementRun['status'];

const STATUS_TONE: Record<RunStatus, StatusPillTone> = {
  pending: 'warning',
  processing: 'warning',
  paid_out: 'positive',
  failed: 'negative',
};

const STATUS_LABEL: Record<RunStatus, string> = {
  pending: 'Pending',
  processing: 'Processing',
  paid_out: 'Paid out',
  failed: 'Failed',
};

function extractFirstErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
    for (const value of Object.values(error as Record<string, unknown>)) {
      if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0];
      }
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  return fallback;
}

/**
 * Settlement runs for one Business (`GET`/`POST /settlement-runs/`) —
 * Phase 5 frontend Slice C. `SettlementRun` is otherwise invisible
 * everywhere else in the frontend: it's `IsPlatformStaff`-gated, not a
 * Role/Permission codename (a payout is a platform financial
 * operation, not client self-service), so client-admin-app's own
 * Ledger screen deliberately has no read path to it either — this is
 * the only place any of this data is ever shown, to anyone.
 */
@Component({
  selector: 'app-settlement-runs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    ReactiveFormsModule,
    RouterLink,
    Alert,
    Button,
    EmptyState,
    Paginator,
    StatusPill,
    Table,
    TextField,
  ],
  templateUrl: './settlement-runs.html',
})
export class SettlementRuns implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly businessStore = inject(BusinessSuperAdminStore);
  protected readonly store = inject(SettlementRunStore);

  protected readonly statusTone = STATUS_TONE;
  protected readonly statusLabel = STATUS_LABEL;

  protected readonly businessId = signal('');
  protected readonly business = signal<BusinessSuperAdmin | null>(null);
  protected readonly notFound = signal(false);

  protected readonly triggering = signal(false);
  protected readonly triggerError = signal<string | null>(null);
  protected readonly payoutNotConfigured = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    period_start: ['', Validators.required],
    period_end: ['', Validators.required],
  });

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      return;
    }
    this.businessId.set(id);

    const business = await this.businessStore.findById(id);
    if (!business) {
      this.notFound.set(true);
      return;
    }
    this.business.set(business);
    void this.store.updateQuery({ business: id });
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected totalLabel(run: SettlementRun): string {
    return `${run.currency} ${run.total_amount}`;
  }

  protected async onTrigger(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.triggering.set(true);
    this.triggerError.set(null);
    this.payoutNotConfigured.set(false);
    const { period_start, period_end } = this.form.getRawValue();

    const { data, error, response } = await this.api.POST('/api/v1/settlement-runs/', {
      body: { business: this.businessId(), period_start, period_end },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    this.triggering.set(false);

    if (!data) {
      if (response.status === 404) {
        this.payoutNotConfigured.set(true);
      }
      this.triggerError.set(
        extractFirstErrorMessage(error, 'Could not trigger a settlement run.')
      );
      return;
    }

    this.form.reset({ period_start: '', period_end: '' });
    await this.store.getAll();
  }
}
