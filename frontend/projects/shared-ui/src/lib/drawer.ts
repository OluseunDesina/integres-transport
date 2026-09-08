import { Dialog, DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Overlay } from '@angular/cdk/overlay';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, Injectable, TemplateRef, inject } from '@angular/core';

import { Icon } from './icon';

export const DRAWER_TITLE_ID = 'ui-drawer-title';

export interface DrawerData {
  title: string;
  description?: string;
  bodyTemplate: TemplateRef<unknown>;
  /** Actions pinned to the bottom of the panel — usually save/cancel. */
  footerTemplate?: TemplateRef<unknown>;
}

export interface DrawerOptions extends DrawerData {
  /** Set while a save is in flight, so a stray Escape cannot discard it. */
  disableClose?: boolean;
}

/**
 * A side panel for contextual work that does not deserve its own route —
 * changing one field on a row, reading a record's detail without losing
 * the list's scroll position and filters.
 *
 * Built on CDK `Dialog` rather than a hand-rolled panel, for the focus
 * behaviour: focus moves into the panel on open, is trapped while it is
 * open, and returns to the trigger on close. `@layout`'s `AuthLayout`
 * records why a full *page* is not focus-trapped; a drawer is the other
 * case, and it is trapped.
 *
 * Content arrives as `TemplateRef`s, mirroring `ui-confirm-dialog`,
 * which keeps the caller's own injection context, forms and permission
 * directives working inside the panel — a component class passed to
 * `Dialog.open` would not have them.
 *
 * **The route is still the right answer for anything bookmarkable.**
 * A drawer's state does not survive a refresh and cannot be linked to,
 * the same reasoning that made `my-bookings/:id/tickets` a real route.
 */
@Component({
  selector: 'ui-drawer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block h-full' },
  imports: [NgTemplateOutlet, Icon],
  template: `
    <div class="flex h-full w-screen max-w-md flex-col bg-surface shadow-xl">
      <header class="flex items-start justify-between gap-4 border-b border-border p-4">
        <div class="flex flex-col gap-1">
          <h2 [id]="titleId" class="text-base font-semibold text-strong">{{ data.title }}</h2>
          @if (data.description; as text) {
            <p class="text-sm text-muted">{{ text }}</p>
          }
        </div>
        <button
          type="button"
          aria-label="Close panel"
          (click)="close()"
          class="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-muted hover:text-default focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
        >
          <ui-icon name="x-mark" [size]="20" />
        </button>
      </header>

      <div class="flex-1 overflow-y-auto p-4">
        <ng-container *ngTemplateOutlet="data.bodyTemplate" />
      </div>

      @if (data.footerTemplate; as footer) {
        <footer class="flex justify-end gap-3 border-t border-border p-4">
          <ng-container *ngTemplateOutlet="footer" />
        </footer>
      }
    </div>
  `,
})
export class Drawer {
  protected readonly data = inject<DrawerData>(DIALOG_DATA);
  private readonly dialogRef = inject(DialogRef<unknown>);

  protected readonly titleId = DRAWER_TITLE_ID;

  protected close(): void {
    this.dialogRef.close();
  }
}

/**
 * Opens `Drawer` with the side-panel configuration.
 *
 * A service rather than a documented `Dialog.open` recipe because that
 * configuration is the accessible bit and is easy to get subtly wrong:
 * `ariaModal` defaults **off** in plain `@angular/cdk/dialog`, and
 * `ariaLabelledBy` has no automatic wiring the way Angular Material's
 * `MatDialogTitle` provides — exactly the trap `ui-confirm-dialog`'s own
 * docstring already records for callers who open it themselves. Here the
 * component and its config ship together so no call site can omit
 * either.
 */
@Injectable({ providedIn: 'root' })
export class DrawerService {
  private readonly dialog = inject(Dialog);
  private readonly overlay = inject(Overlay);

  open<R = unknown>(options: DrawerOptions): DialogRef<R, Drawer> {
    const { disableClose = false, ...data } = options;

    return this.dialog.open<R, DrawerData, Drawer>(Drawer, {
      data,
      // Right-anchored and full height. A global strategy, not a
      // connected one — the panel is anchored to the viewport, not to
      // whichever row's button opened it.
      positionStrategy: this.overlay.position().global().right('0').top('0'),
      height: '100%',
      disableClose,
      ariaModal: true,
      ariaLabelledBy: DRAWER_TITLE_ID,
      // The heading, not the close button: a screen reader entering the
      // panel should hear what the panel *is* before how to leave it.
      // CDK's `first-heading` target adds `tabindex="-1"` to the `<h2>`
      // itself — passing a CSS selector here instead would silently fail,
      // since a bare heading is not focusable and `focus()` on it is a
      // no-op that leaves focus on `<body>`.
      autoFocus: 'first-heading',
    });
  }
}
