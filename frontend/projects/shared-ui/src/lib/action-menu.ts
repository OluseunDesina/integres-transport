import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, output } from '@angular/core';

import { Icon, type IconName } from './icon';

export interface ActionMenuItem {
  /** Echoed back on `selected`. */
  id: string;
  label: string;
  icon?: IconName;
  /** Renders in the danger tone. Does not confirm — see the note below. */
  danger?: boolean;
  disabled?: boolean;
}

/**
 * The per-row action menu, replacing the bare "Edit" text links that
 * every list currently ends with.
 *
 * Items are **data, not projected content**, and that is the load-bearing
 * decision here. `@angular/cdk/menu` gives the whole keyboard and focus
 * contract — `role="menu"`/`menuitem`, arrow keys, Home/End, typeahead,
 * Escape, focus returning to the trigger — but only for elements
 * carrying `cdkMenuItem`. Projected content would put the burden of
 * importing that directive on thirty-five call sites, and any one that
 * forgot would render a menu that looks right and is unreachable by
 * keyboard. Taking items as data makes that impossible to get wrong.
 *
 * `danger: true` styles an item; it does not confirm it. Destructive
 * actions go through `ui-confirm-dialog`, which the caller opens from
 * its `selected` handler — the menu closing and a dialog opening is the
 * "one deliberate step instead of one accidental one" that
 * docs/specs/14 asks for in place of an in-table toggle.
 *
 * `label` is required rather than defaulted because a table of these
 * would otherwise announce identically in every row — the same reasoning
 * `ui-toggle`'s required `label` records. Pass the row's identity:
 * "Actions for LAG-231-KJA".
 *
 * The trigger is sized from `--ui-control-height` rather than the
 * `min-h-11` this library uses everywhere else, and that is the one
 * deliberate exception. Every row of every list renders one of these, so
 * a fixed 44px floor sets the row height for the whole console: it took
 * the vehicles table from ~40px rows to ~68px, roughly halving what fits
 * on a screen. The surface profile already encodes the right answer —
 * 36px on `console`, 44px on `consumer` — and 36px clears WCAG 2.2
 * SC 2.5.8's 24px minimum with room to spare on a pointer-driven
 * back-office table. This is also the first thing in the workspace that
 * actually reads a surface-profile token; before it, `data-surface` was
 * set on every app's `<html>` and changed nothing.
 *
 * A disabled item binds `cdkMenuItemDisabled`, **never** the native
 * `disabled` attribute. CDK's menu key manager runs
 * `skipPredicate(() => false)`, so arrow keys deliberately land on
 * disabled items (the APG behaviour — a disabled option a keyboard user
 * cannot reach is a disabled option they never learn exists). A natively
 * disabled `<button>` is unfocusable, so `focus()` would silently no-op
 * and arrow navigation would stall on it. The directive's own input sets
 * `aria-disabled` and swallows the click.
 */
@Component({
  selector: 'ui-action-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-block' },
  imports: [CdkMenu, CdkMenuItem, CdkMenuTrigger, Icon],
  template: `
    <button
      type="button"
      [attr.aria-label]="label()"
      [disabled]="disabled()"
      [cdkMenuTriggerFor]="menu"
      class="inline-flex items-center justify-center gap-1.5 rounded-md border border-control text-default hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:text-muted"
      [class.px-3]="!!triggerLabel()"
      style="min-height: var(--ui-control-height); min-width: var(--ui-control-height)"
    >
      @if (triggerLabel(); as text) {
        <span class="text-sm font-medium">{{ text }}</span>
        <ui-icon name="chevron-down" [size]="16" />
      } @else {
        <ui-icon name="ellipsis-horizontal" [size]="20" />
      }
    </button>

    <ng-template #menu>
      <div
        cdkMenu
        class="min-w-48 rounded-md border border-border bg-surface py-1 shadow-md"
        [attr.aria-label]="label()"
      >
        @for (item of items(); track item.id) {
          <button
            type="button"
            cdkMenuItem
            [cdkMenuItemDisabled]="!!item.disabled"
            (cdkMenuItemTriggered)="choose(item.id)"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm focus-visible:bg-surface-muted focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-focus"
            [class.hover:bg-surface-muted]="!item.disabled"
            [class.cursor-not-allowed]="!!item.disabled"
            [class.text-muted]="!!item.disabled"
            [class.text-danger]="!!item.danger && !item.disabled"
            [class.text-default]="!item.danger && !item.disabled"
          >
            @if (item.icon; as icon) {
              <ui-icon [name]="icon" [size]="16" />
            }
            <span>{{ item.label }}</span>
          </button>
        }
      </div>
    </ng-template>
  `,
})
export class ActionMenu {
  private readonly destroyRef = inject(DestroyRef);

  readonly items = input.required<ActionMenuItem[]>();
  readonly label = input.required<string>();
  /**
   * Visible text on the trigger, turning it from an icon-only "…" into a
   * labelled dropdown.
   *
   * Omitted in a table row, where the column and the row's own identity
   * supply the context and an ellipsis is the established affordance.
   * **Required in practice for a standalone menu**: the shell's
   * quick-create control first shipped icon-only, and a bare "…" alone
   * in a top bar tells nobody it creates records — `aria-label` reaches
   * screen-reader users and no one else. Found in the slice's visual
   * pass, not by a test.
   */
  readonly triggerLabel = input<string | null>(null);
  readonly disabled = input(false);
  /**
   * Emitted **after** the menu has closed and returned focus to the
   * trigger — one macrotask later than the click, not during it. See
   * `choose` for why.
   */
  readonly selected = output<string>();

  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.pending !== null) {
        clearTimeout(this.pending);
      }
    });
  }

  /**
   * Deferred by one macrotask, and this is load-bearing rather than
   * defensive.
   *
   * CDK's `CdkMenuItem.trigger()` emits `triggered` **before** it calls
   * `menuStack.closeAll()`, so a handler running synchronously runs
   * while the menu is still open and focus is still on the menu item
   * that is about to be destroyed. A handler that opens a dialog or
   * drawer therefore captures that doomed element as its
   * focus-restoration target, and closing the overlay drops focus to
   * `<body>` — stranding a keyboard user at the top of the document,
   * the exact failure this menu's own focus-return test guards against.
   *
   * Deferring here fixes it once for every consumer, rather than asking
   * thirty-five call sites to remember a `setTimeout` — and no call site
   * that forgot would look wrong.
   *
   * Found by e2e, not by unit tests: focus restoration needs a real
   * browser and a real overlay to go wrong in.
   */
  protected choose(id: string): void {
    this.pending = setTimeout(() => {
      this.pending = null;
      this.selected.emit(id);
    });
  }
}
