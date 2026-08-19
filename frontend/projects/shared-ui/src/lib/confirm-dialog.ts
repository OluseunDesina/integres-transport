import { NgTemplateOutlet } from '@angular/common';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, TemplateRef, inject, signal } from '@angular/core';
import type { Signal } from '@angular/core';

import { Alert } from './alert';
import { Button } from './button';

export const CONFIRM_DIALOG_TITLE_ID = 'ui-confirm-dialog-title';

export type ConfirmDialogResult = { ok: true } | { ok: false; error: string };

export interface ConfirmDialogData {
  title: string;
  bodyTemplate: TemplateRef<unknown>;
  confirmLabel: Signal<string>;
  danger: Signal<boolean>;
  confirmDisabled: Signal<boolean>;
  onConfirm: () => Promise<ConfirmDialogResult>;
}

/**
 * First CDK `Dialog` usage in the repo. Every caller's `dialog.open()`
 * config must explicitly set `ariaModal: true` and `ariaLabelledBy:
 * CONFIRM_DIALOG_TITLE_ID` — `role="dialog"`/focus trap/restoration are
 * free from `DialogContainer`, but `ariaModal` defaults off and there's
 * no public `aria-labelledby` wiring in plain `@angular/cdk/dialog`
 * (unlike Angular Material's `MatDialogTitle`). Don't duplicate
 * role/aria-modal on the inner card below — those already land on the
 * real `cdk-dialog-container` ancestor via config.
 *
 * Owns the submit lifecycle itself via `data.onConfirm` rather than
 * closing on client-side-valid-click and letting the caller POST after
 * the dialog is already gone — this is what lets a server-side error
 * (a blank-reason rejection, or a row another platform-staff member
 * already decided) surface inline while the dialog is still open,
 * instead of failing silently after close.
 */
@Component({
  selector: 'ui-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [NgTemplateOutlet, Alert, Button],
  template: `
    <div class="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
      <h2 [id]="titleId" class="text-base font-semibold text-slate-900">{{ data.title }}</h2>
      <div class="mt-4">
        <ng-container *ngTemplateOutlet="data.bodyTemplate" />
      </div>
      @if (submitError(); as message) {
        <ui-alert variant="error" class="mt-4">{{ message }}</ui-alert>
      }
      <div class="mt-6 flex justify-end gap-3">
        <ui-button variant="secondary" [disabled]="submitting()" (pressed)="cancel()">
          Cancel
        </ui-button>
        <ui-button
          [variant]="data.danger() ? 'danger' : 'primary'"
          [loading]="submitting()"
          [disabled]="data.confirmDisabled()"
          (pressed)="confirm()"
        >
          {{ data.confirmLabel() }}
        </ui-button>
      </div>
    </div>
  `,
})
export class ConfirmDialog {
  protected readonly data = inject<ConfirmDialogData>(DIALOG_DATA);
  private readonly dialogRef = inject(DialogRef<boolean>);

  protected readonly titleId = CONFIRM_DIALOG_TITLE_ID;
  protected readonly submitting = signal(false);
  protected readonly submitError = signal<string | null>(null);

  protected cancel(): void {
    this.dialogRef.close(false);
  }

  protected async confirm(): Promise<void> {
    if (this.submitting() || this.data.confirmDisabled()) {
      return;
    }
    this.submitting.set(true);
    this.submitError.set(null);
    this.dialogRef.disableClose = true;

    try {
      const result = await this.data.onConfirm();
      if (result.ok) {
        this.dialogRef.close(true);
        return;
      }
      this.submitError.set(result.error);
    } finally {
      this.submitting.set(false);
      this.dialogRef.disableClose = false;
    }
  }
}
