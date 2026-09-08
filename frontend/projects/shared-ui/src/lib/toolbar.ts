import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { Button } from './button';

/**
 * The contextual strip above a table: how many rows are selected, what
 * can be done to them, and a way out of the selection.
 *
 * **Not `role="toolbar"`, deliberately.** That role carries a keyboard
 * contract — a single tab stop with arrow-key roving focus across the
 * controls — which cannot be honoured for arbitrary projected content,
 * since this component has no handle on what the caller projects. A
 * `role="toolbar"` without roving focus is worse than no role: it
 * promises a screen-reader user a navigation model that then does not
 * work. The controls stay ordinary tab stops, and the strip is a plain
 * labelled group.
 *
 * The selection count lives in an `aria-live="polite"` region because
 * selecting a row is a mouse/keyboard action whose *result* is only
 * rendered here — without the live region, a screen-reader user ticking
 * checkboxes gets no feedback that the count moved.
 */
@Component({
  selector: 'ui-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [Button],
  template: `
    <div
      role="group"
      [attr.aria-label]="ariaLabel()"
      class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-muted px-3 py-2"
      style="min-height: var(--ui-control-height)"
    >
      <div class="flex items-center gap-3">
        <p aria-live="polite" class="text-sm font-medium text-strong">{{ countLabel() }}</p>
        @if (selectedCount() > 0) {
          <ui-button variant="secondary" (pressed)="cleared.emit()">Clear selection</ui-button>
        }
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <ng-content />
      </div>
    </div>
  `,
})
export class Toolbar {
  readonly selectedCount = input(0);
  /**
   * Singular noun for what is being selected — "vehicle", "booking".
   * Pluralised by appending "s", which is correct for every noun this
   * console actually selects; a caller needing otherwise should pass
   * `itemLabelPlural`.
   */
  readonly itemLabel = input('item');
  readonly itemLabelPlural = input<string | null>(null);
  readonly ariaLabel = input('Table actions');
  readonly cleared = output<void>();

  protected readonly countLabel = computed(() => {
    const count = this.selectedCount();
    if (count === 0) {
      return 'None selected';
    }
    const noun =
      count === 1 ? this.itemLabel() : (this.itemLabelPlural() ?? `${this.itemLabel()}s`);
    return `${count} ${noun} selected`;
  });
}
