import { CdkMenu, CdkMenuGroup, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, output } from '@angular/core';

import { Icon } from './icon';

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

/** What the export covers. */
export type ExportScope = 'view' | 'all';

export interface ExportRequest {
  format: ExportFormat;
  scope: ExportScope;
}

const FORMAT_LABELS: Record<ExportFormat, string> = {
  csv: 'CSV',
  xlsx: 'Excel',
  pdf: 'PDF',
};

/**
 * Export, with the scope made explicit rather than assumed.
 *
 * The scope choice is the whole point. A single "Export" button on a
 * filtered, paginated list is ambiguous in a way that matters: an
 * operator exporting a reconciliation report almost always means every
 * matching row, and an operator exporting what they are looking at means
 * this page. Guessing either way produces a file that is silently wrong
 * — the wrong row count with no indication — so the menu asks.
 *
 * This component **requests** an export and renders the waiting state;
 * it never fetches or builds a file. Generating a whole-result-set
 * export is a paginated fetch loop or a backend endpoint, and both are
 * the caller's business (spec 16 owns the analytics exports that first
 * need it).
 *
 * `cdkMenuGroup` is what makes the two scopes announce as two groups
 * rather than one flat list of six near-identical items.
 */
@Component({
  selector: 'ui-export-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-block' },
  imports: [CdkMenu, CdkMenuGroup, CdkMenuItem, CdkMenuTrigger, Icon],
  template: `
    <button
      type="button"
      [attr.aria-label]="label()"
      [disabled]="disabled() || pending()"
      [cdkMenuTriggerFor]="menu"
      class="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-control px-4 py-2 text-sm font-medium text-default hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:text-muted"
    >
      @if (pending()) {
        <span
          class="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        ></span>
      } @else {
        <ui-icon name="arrow-down-tray" [size]="18" />
      }
      <span>{{ pending() ? 'Exporting…' : 'Export' }}</span>
    </button>

    <ng-template #menu>
      <div cdkMenu class="min-w-56 rounded-md border border-border bg-surface py-1 shadow-md">
        @for (scope of scopes(); track scope; let first = $first) {
          <div
            cdkMenuGroup
            [attr.aria-label]="scopeLabel(scope)"
            [class]="first ? '' : 'mt-1 border-t border-border'"
          >
            <!--
              The group heading is suppressed when there is only one
              scope. With both, it is the whole point of the menu — with
              one, it labels a group of one against nothing, which reads
              as a category that lost its siblings.
            -->
            @if (scopes().length > 1) {
              <p class="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">
                {{ scopeLabel(scope) }}
              </p>
            }
            @for (format of formats(); track format) {
              <button
                type="button"
                cdkMenuItem
                (cdkMenuItemTriggered)="choose(format, scope)"
                class="flex w-full items-center px-3 py-2 text-left text-sm text-default hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-focus"
              >
                {{ formatLabel(format) }}
              </button>
            }
          </div>
        }
      </div>
    </ng-template>
  `,
})
export class ExportButton {
  private readonly destroyRef = inject(DestroyRef);

  readonly formats = input<ExportFormat[]>(['csv']);
  readonly disabled = input(false);
  readonly pending = input(false);
  readonly label = input('Export');
  /**
   * Names what "this view" means where the wording matters — "Current
   * page" on a paginated table, "Selected rows" where a selection is
   * live. Vague by default is worse than specific.
   */
  readonly viewGroupLabel = input('Current view');
  /**
   * Which scopes to offer, in order.
   *
   * Both by default, which is the case this component was built for. A
   * caller passing one gets a flat menu with no group headings — spec 16
   * slice 4's screens do exactly that, because their export is served by
   * the backend from the caller's active filters, so "Current view" and
   * "All results" would be two menu items producing byte-identical
   * files. Offering a choice that does not exist is worse than offering
   * none: it implies the other option would have given something else.
   */
  readonly scopes = input<ExportScope[]>(['view', 'all']);

  /**
   * Emitted **after** the menu has closed and returned focus to the
   * trigger — see `ui-action-menu`'s `choose` for the full account. Same
   * CDK menu, same ordering trap: `triggered` fires before `closeAll`,
   * so a handler that opens anything captures a focus target that is
   * about to be destroyed. Kept identical here rather than left
   * synchronous because "export opens a dialog" is exactly the shape
   * spec 16's own export flows are likely to take.
   */
  readonly exportRequested = output<ExportRequest>();

  // Not `pending` — that name is already the input above.
  private pendingEmit: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.pendingEmit !== null) {
        clearTimeout(this.pendingEmit);
      }
    });
  }

  protected choose(format: ExportFormat, scope: ExportScope): void {
    this.pendingEmit = setTimeout(() => {
      this.pendingEmit = null;
      this.exportRequested.emit({ format, scope });
    });
  }

  protected formatLabel(format: ExportFormat): string {
    return FORMAT_LABELS[format];
  }

  protected scopeLabel(scope: ExportScope): string {
    return scope === 'view' ? this.viewGroupLabel() : 'All results';
  }
}
