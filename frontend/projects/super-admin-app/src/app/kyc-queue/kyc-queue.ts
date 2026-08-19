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
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import {
  Alert,
  Button,
  CONFIRM_DIALOG_TITLE_ID,
  ConfirmDialog,
  EmptyState,
  Paginator,
  StatusPill,
  Table,
} from '@shared-ui';
import type { ConfirmDialogData, ConfirmDialogResult } from '@shared-ui';

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
  imports: [Alert, Button, EmptyState, Paginator, StatusPill, Table],
  templateUrl: './kyc-queue.html',
})
export class KycQueue implements OnInit {
  protected readonly store = inject(KycQueueStore);
  private readonly dialog = inject(Dialog);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  @ViewChild('decideBody') private readonly decideBody!: TemplateRef<unknown>;

  protected readonly decision = signal<'approve' | 'reject'>('approve');
  protected readonly reason = signal('');
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

  protected setDecision(value: 'approve' | 'reject'): void {
    this.decision.set(value);
  }

  protected setReason(value: string): void {
    this.reason.set(value);
  }

  protected review(client: ClientKycQueueItem): void {
    this.decision.set('approve');
    this.reason.set('');

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
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    return error ? { ok: false, error: extractFirstErrorMessage(error) } : { ok: true };
  }
}
