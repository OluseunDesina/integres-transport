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
import { API_CLIENT } from '@api-client';
import {
  Alert,
  Button,
  CONFIRM_DIALOG_TITLE_ID,
  ConfirmDialog,
  EmptyState,
  FilterBar,
  PageHeader,
  Paginator,
  RadioGroup,
  StatusPill,
  Table,
  Textarea,
  plural,
  summaryLine,
} from '@shared-ui';
import type { ConfirmDialogData, ConfirmDialogResult, SelectOption } from '@shared-ui';

import { KybQueueStore, type BusinessKybQueueItem } from '../shared/data/store/kyb-queue.store';

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

@Component({
  selector: 'app-kyb-queue',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    Alert,
    Button,
    EmptyState,
    FilterBar,
    PageHeader,
    Paginator,
    RadioGroup,
    StatusPill,
    Table,
    Textarea,
  ],
  templateUrl: './kyb-queue.html',
})
export class KybQueue implements OnInit {
  protected readonly store = inject(KybQueueStore);
  private readonly dialog = inject(Dialog);
  private readonly api = inject(API_CLIENT);

  protected onSearchChange(value: string): void {
    void this.store.updateQuery({ search: value || undefined });
  }

  @ViewChild('decideBody') private readonly decideBody!: TemplateRef<unknown>;

  protected readonly decisionOptions: SelectOption[] = [
    { value: 'approve', label: 'Approve' },
    { value: 'reject', label: 'Reject' },
  ];

  protected readonly decision = signal<'approve' | 'reject'>('approve');
  protected readonly reason = signal('');
  /** Whether the reason box has been touched, so an empty one is not
   * red the instant Reject is chosen — the confirm button is already
   * disabled, which is the non-accusatory signal. */
  protected readonly reasonTouched = signal(false);
  protected readonly confirmDisabled = computed(
    () => this.decision() === 'reject' && !this.reason().trim()
  );
  protected readonly danger = computed(() => this.decision() === 'reject');
  protected readonly confirmLabel = computed(() =>
    this.decision() === 'reject' ? 'Reject' : 'Approve'
  );

  ngOnInit(): void {
    void this.store.getAll();
  }

  /** Every director on the packet, including soft-removed ones — one may
   * still own an ID document in this submission, and omitting them would
   * leave a reviewer looking at an ID whose owner isn't listed. */
  protected directorNames(business: BusinessKybQueueItem): string {
    // No `?? []` fallback: the serializer always emits the array, and the
    // generated type says so — NG8107 flagged the matching `?.` in the
    // template as provably dead. A defensive guard that the compiler can
    // prove unreachable only obscures where the real nullability is.
    return business.directors.map((director) => director.full_name).join(', ');
  }
  /** Everything hidden below `md`. */
  protected summaryForNarrow(business: BusinessKybQueueItem): string {
    return summaryLine([
      business.client_name,
      business.vertical,
      business.directors.length ? this.directorNames(business) : 'No directors listed',
      plural(business.documents.length, 'document'),
    ]);
  }

  /** Only the long tail — Client and Directors have their own columns
   * from `md` up, so repeating them here would say everything twice. */
  protected summaryForMedium(business: BusinessKybQueueItem): string {
    return summaryLine([business.vertical, plural(business.documents.length, 'document')]);
  }


  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
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

  protected setDecision(value: 'approve' | 'reject'): void {
    this.decision.set(value);
  }

  protected setReason(value: string): void {
    this.reasonTouched.set(true);
    this.reason.set(value);
  }

  protected review(business: BusinessKybQueueItem): void {
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
    // cancel/Escape (`false`/`undefined`) — a cancelled review leaves
    // the row genuinely unchanged, so there is nothing to reload. This
    // was previously unconditional ("both cases are naturally reflected
    // by the same unconditional reload"), which was itself a real bug
    // (confirmed empirically against `kyc-queue.ts`'s identical
    // pattern): a refetch flips `ui-table`'s `loading` state, tearing
    // down and recreating the whole table — including the Review
    // button CDK's Dialog had *just* synchronously restored focus to —
    // and the freshly-created button is a different DOM node that
    // `focus()` was never called on. The `setTimeout` deferral only
    // avoided racing that initial synchronous restoration; it did
    // nothing to stop this second, later loss once the deferred
    // refetch itself fired and rebuilt the row a moment later.
    // Confirmed dialogs still need the reload; Escape and Cancel now
    // correctly leave both the data and the focused element alone.
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
