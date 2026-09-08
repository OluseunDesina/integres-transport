import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import {
  Alert,
  Button,
  EmptyState,
  PageHeader,
  Paginator,
  StatusPill,
  Table,
  TextField,
  applyServerErrors,
  clearServerErrors,
  fieldErrorMessage,
} from '@shared-ui';
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
    PageHeader,
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

  protected readonly heading = computed(() => {
    const business = this.business();
    return business ? `Settlement runs — ${business.name}` : 'Settlement runs';
  });

  /** Both dates are required and neither bound an error input, so an
   * empty submit did nothing and said nothing — spec 11's trap. */
  protected fieldError(field: 'period_start' | 'period_end'): string | null {
    return fieldErrorMessage(this.form.controls[field], {
      label: field === 'period_start' ? 'Period start' : 'Period end',
    });
  }

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
    clearServerErrors(this.form);
    const { period_start, period_end } = this.form.getRawValue();

    const { data, error, response } = await this.api.POST('/api/v1/settlement-runs/', {
      body: { business: this.businessId(), period_start, period_end },
    });

    this.triggering.set(false);

    if (!data) {
      if (response.status === 404) {
        this.payoutNotConfigured.set(true);
      }
      // A rejected period lands on the date it belongs to; anything
      // else (including the 404 above) still reaches the page alert.
      this.triggerError.set(
        applyServerErrors(this.form, error, 'Could not trigger a settlement run.')
      );
      return;
    }

    this.form.reset({ period_start: '', period_end: '' });
    await this.store.getAll();
  }
}
