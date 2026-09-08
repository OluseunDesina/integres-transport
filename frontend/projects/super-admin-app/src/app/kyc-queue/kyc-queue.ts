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

import { KycQueueStore, type ClientKycQueueItem } from '../shared/data/store/kyc-queue.store';

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
  selector: 'app-kyc-queue',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    Alert,
    Button,
    EmptyState,
    PageHeader,
    Paginator,
    RadioGroup,
    StatusPill,
    Table,
    Textarea,
  ],
  templateUrl: './kyc-queue.html',
})
export class KycQueue implements OnInit {
  protected readonly store = inject(KycQueueStore);
  private readonly dialog = inject(Dialog);
  private readonly api = inject(API_CLIENT);

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
      ? 'Give a reason — the client sees it.'
      : null;
  }

  protected setDecision(value: 'approve' | 'reject'): void {
    this.decision.set(value);
  }

  protected setReason(value: string): void {
    this.reasonTouched.set(true);
    this.reason.set(value);
  }

  /** The columns hidden below `md`, re-flowed under the client name. */
  protected summaryFor(client: ClientKycQueueItem): string {
    return summaryLine([client.email, plural(client.documents.length, 'document')]);
  }

  protected review(client: ClientKycQueueItem): void {
    this.decision.set('approve');
    this.reason.set('');
    this.reasonTouched.set(false);

    const ref = this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `Review ${client.name}`,
        bodyTemplate: this.decideBody,
        confirmLabel: this.confirmLabel,
        danger: this.danger,
        confirmDisabled: this.confirmDisabled,
        onConfirm: () => this.submitDecision(client.id),
      },
    });

    // Refetch either way — a cancelled review leaves the row unchanged,
    // a confirmed one leaves it decided; both cases are naturally
    // reflected by the same unconditional reload. Deferred one tick:
    // `getAll()` flips `ui-table`'s `loading` state, which tears down and
    // recreates the whole table (including the Review button CDK is
    // restoring focus to) — refetching in the same synchronous tick as
    // the dialog's own close/focus-restoration sequence raced it and
    // silently dropped focus onto nothing.
    ref.closed.subscribe(() => {
      setTimeout(() => void this.store.getAll());
    });
  }

  private async submitDecision(clientId: string): Promise<ConfirmDialogResult> {
    const { error } = await this.api.POST('/api/v1/super-admin/kyc-queue/{client_id}/decide/', {
      params: { path: { client_id: clientId } },
      body: { decision: this.decision(), reason: this.reason() || undefined },
    });

    return error ? { ok: false, error: extractFirstErrorMessage(error) } : { ok: true };
  }
}
