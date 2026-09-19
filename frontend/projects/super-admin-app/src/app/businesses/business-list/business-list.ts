import { Dialog } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  TemplateRef,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import {
  ActionMenu,
  Alert,
  CONFIRM_DIALOG_TITLE_ID,
  ConfirmDialog,
  EmptyState,
  FilterBar,
  PageHeader,
  Paginator,
  RadioGroup,
  Select,
  StatusPill,
  Table,
  Textarea,
} from '@shared-ui';
import type {
  ActionMenuItem,
  ConfirmDialogData,
  ConfirmDialogResult,
  FilterChip,
  SelectOption,
  StatusPillTone,
} from '@shared-ui';

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

const KYB_STATUS_OPTIONS: SelectOption[] = [
  { value: '', label: 'All KYB statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

const VERTICAL_OPTIONS: SelectOption[] = [
  { value: '', label: 'All verticals' },
  { value: 'shuttle', label: 'Shuttle' },
  { value: 'intercity', label: 'Intercity' },
  { value: 'metro', label: 'Metro' },
];

const ACTIVE_OPTIONS: SelectOption[] = [
  { value: '', label: 'All statuses' },
  { value: 'true', label: 'Active only' },
  { value: 'false', label: 'Inactive only' },
];

function extractFirstErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    for (const value of Object.values(error as Record<string, unknown>)) {
      if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0];
      }
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  return 'Could not save this decision. Try again.';
}

/**
 * Cross-client Business search for platform staff (`GET /super-admin/
 * businesses/`) — Phase 5 frontend Slice C, the entry point for the
 * other two new screens (Paystack config, settlement runs), neither of
 * which had any way to find a Business before this one existed:
 * `GET /businesses/` is Client-scoped, and the KYB queue drops a
 * Business the moment it's approved.
 *
 * Merged with the formerly-separate KYB queue page: both rendered
 * `Business` rows with no way to cross-filter between the two screens,
 * so `kyb_status`/`vertical`/`is_active` are now filters on this one
 * list instead. The KYB review action moved here too — a `ui-action-menu`
 * item that only appears while `kyb_status === 'submitted'`, mirroring
 * `client-admin-app`'s own conditional-menu-item convention rather than
 * a separately-plumbed `disabled` state — and disappears the moment a
 * decision is made, since a re-fetch after a decision no longer matches
 * `submitted`.
 */
@Component({
  selector: 'app-business-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ActionMenu,
    Alert,
    EmptyState,
    FilterBar,
    PageHeader,
    Paginator,
    RadioGroup,
    Select,
    StatusPill,
    Table,
    Textarea,
  ],
  templateUrl: './business-list.html',
})
export class BusinessList implements OnInit {
  protected readonly store = inject(BusinessSuperAdminStore);
  private readonly router = inject(Router);
  private readonly dialog = inject(Dialog);
  private readonly api = inject(API_CLIENT);

  protected readonly statusTone = KYB_STATUS_TONE;
  protected readonly statusLabel = KYB_STATUS_LABEL;
  protected readonly kybStatusOptions = KYB_STATUS_OPTIONS;
  protected readonly verticalOptions = VERTICAL_OPTIONS;
  protected readonly activeOptions = ACTIVE_OPTIONS;

  protected readonly searchTerm = signal('');
  protected readonly kybStatusFilter = signal('');
  protected readonly verticalFilter = signal('');
  protected readonly activeFilter = signal('');

  protected readonly chips = computed<FilterChip[]>(() => {
    const chips: FilterChip[] = [];
    const term = this.searchTerm().trim();
    if (term) {
      chips.push({ id: 'search', label: 'Name', value: term });
    }
    const kybStatus = this.kybStatusFilter();
    if (kybStatus) {
      chips.push({
        id: 'kyb_status',
        label: 'KYB status',
        value: this.statusLabel[kybStatus as KybStatus],
      });
    }
    const vertical = this.verticalFilter();
    if (vertical) {
      chips.push({ id: 'vertical', label: 'Vertical', value: vertical });
    }
    const active = this.activeFilter();
    if (active) {
      chips.push({ id: 'is_active', label: 'Status', value: active === 'true' ? 'Active' : 'Inactive' });
    }
    return chips;
  });

  ngOnInit(): void {
    void this.store.getAll();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  private applyFilters(): void {
    // `updateQuery` resets to the first page, which is what a changed
    // filter should do — staying on page 4 of a narrower result set is
    // how "no businesses found" gets shown for a search that matched.
    void this.store.updateQuery({
      search: this.searchTerm().trim() || undefined,
      kyb_status: (this.kybStatusFilter() || undefined) as KybStatus | undefined,
      vertical: (this.verticalFilter() || undefined) as BusinessSuperAdmin['vertical'] | undefined,
      is_active: (this.activeFilter() || undefined) as 'true' | 'false' | undefined,
    });
  }

  protected onSearchTermChange(value: string): void {
    // Stored raw, trimmed only on the way into the query and the chip —
    // `searchTerm` feeds the input's own `[value]`, so writing a trimmed
    // string back would delete a trailing space the moment one is typed
    // and jump the cursor.
    this.searchTerm.set(value);
    this.applyFilters();
  }

  protected onKybStatusFilterChange(value: string): void {
    this.kybStatusFilter.set(value);
    this.applyFilters();
  }

  protected onVerticalFilterChange(value: string): void {
    this.verticalFilter.set(value);
    this.applyFilters();
  }

  protected onActiveFilterChange(value: string): void {
    this.activeFilter.set(value);
    this.applyFilters();
  }

  protected onChipRemoved(chipId: string): void {
    if (chipId === 'search') {
      this.searchTerm.set('');
    } else if (chipId === 'kyb_status') {
      this.kybStatusFilter.set('');
    } else if (chipId === 'vertical') {
      this.verticalFilter.set('');
    } else if (chipId === 'is_active') {
      this.activeFilter.set('');
    }
    this.applyFilters();
  }

  protected onFiltersCleared(): void {
    this.searchTerm.set('');
    this.kybStatusFilter.set('');
    this.verticalFilter.set('');
    this.activeFilter.set('');
    this.applyFilters();
  }

  // --- Row actions: a three-dot menu, matching client-admin-app's own
  // `ui-action-menu` convention, replacing the three plain links this
  // list used to render side by side. ---

  protected menuItems(business: BusinessSuperAdmin): ActionMenuItem[] {
    const items: ActionMenuItem[] = [
      { id: 'paystack-account', label: 'Paystack account', icon: 'banknotes' },
      { id: 'settlement-runs', label: 'Settlements', icon: 'credit-card' },
      { id: 'seat-hold', label: 'Seat hold', icon: 'clock' },
    ];
    // Disappears once reviewed, rather than a separately-wired `disabled`
    // state — a re-fetch after a decision no longer matches `submitted`,
    // so the item is simply absent on the next render.
    if (business.kyb_status === 'submitted') {
      items.push({ id: 'review-kyb', label: 'Review KYB', icon: 'document-check' });
    }
    return items;
  }

  protected onMenuSelected(business: BusinessSuperAdmin, id: string): void {
    if (id === 'review-kyb') {
      this.review(business);
      return;
    }
    void this.router.navigate(['/businesses', business.id, id]);
  }

  // --- KYB decide dialog — moved here unchanged from the formerly
  // separate kyb-queue page. ---

  @ViewChild('decideBody') private readonly decideBody!: TemplateRef<unknown>;

  protected readonly decisionOptions: SelectOption[] = [
    { value: 'approve', label: 'Approve' },
    { value: 'reject', label: 'Reject' },
  ];

  protected readonly decision = signal<'approve' | 'reject'>('approve');
  protected readonly reason = signal('');
  /** Whether the reason box has been touched, so an empty one is not red
   * the instant Reject is chosen — the confirm button is already
   * disabled, which is the non-accusatory signal. */
  protected readonly reasonTouched = signal(false);
  protected readonly confirmDisabled = computed(
    () => this.decision() === 'reject' && !this.reason().trim()
  );
  protected readonly danger = computed(() => this.decision() === 'reject');
  protected readonly confirmLabel = computed(() =>
    this.decision() === 'reject' ? 'Reject' : 'Approve'
  );

  protected setDecision(value: 'approve' | 'reject'): void {
    this.decision.set(value);
  }

  protected setReason(value: string): void {
    this.reasonTouched.set(true);
    this.reason.set(value);
  }

  /** Why the confirm button is disabled, once the reviewer has actually
   * engaged with the field. `ui-textarea` renders nothing unless the
   * parent binds both `invalid` and `errorMessage` — spec 11's recorded
   * trap — so this is what makes the requirement visible rather than
   * only enforced. */
  protected reasonError(): string | null {
    return this.reasonTouched() && !this.reason().trim()
      ? 'Give a reason — the business sees it.'
      : null;
  }

  private review(business: BusinessSuperAdmin): void {
    this.decision.set('approve');
    this.reason.set('');
    this.reasonTouched.set(false);

    const ref = this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `Review ${business.name}`,
        bodyTemplate: this.decideBody,
        confirmLabel: this.confirmLabel,
        danger: this.danger,
        confirmDisabled: this.confirmDisabled,
        onConfirm: () => this.submitDecision(business.id),
      },
    });

    // Only refetch on an actual decision (`ref.close(true)`), not on
    // cancel/Escape — see the former kyb-queue.ts's own note on why an
    // unconditional refetch used to steal focus CDK had just restored.
    ref.closed.subscribe((result) => {
      if (result) {
        void this.store.getAll();
      }
    });
  }

  private async submitDecision(businessId: string): Promise<ConfirmDialogResult> {
    const { error } = await this.api.POST('/api/v1/super-admin/kyb-queue/{business_id}/decide/', {
      params: { path: { business_id: businessId } },
      body: { decision: this.decision(), reason: this.reason() || undefined },
    });

    return error ? { ok: false, error: extractFirstErrorMessage(error) } : { ok: true };
  }
}
