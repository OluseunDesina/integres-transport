import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { Icon } from './icon';

export type Density = 'comfortable' | 'compact';

/**
 * Comfortable/compact row height for a table.
 *
 * Two toggle buttons with `aria-pressed`, not a `role="radiogroup"`.
 * Both are valid ARIA for a segmented control; toggle buttons win here
 * because a radiogroup owns arrow-key roving focus and Home/End, and a
 * two-option control gains nothing from that while paying for it in
 * behaviour that must then be tested and maintained. Each button is an
 * ordinary tab stop that says whether it is currently on.
 *
 * Icon-only, so both carry a real `aria-label`; the icon itself is
 * `aria-hidden` inside `ui-icon`.
 *
 * The component holds no state and persists nothing — it renders the
 * `density` it is given and emits the one that was asked for. Where the
 * preference is remembered (per screen, per session, not at all) is the
 * caller's decision, and baking a storage key in here would make it this
 * component's.
 */
@Component({
  selector: 'ui-density-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [Icon],
  template: `
    <div role="group" [attr.aria-label]="ariaLabel()" class="inline-flex rounded-md border border-control">
      <button
        type="button"
        aria-label="Comfortable rows"
        [attr.aria-pressed]="density() === 'comfortable'"
        (click)="densityChange.emit('comfortable')"
        class="inline-flex min-h-11 items-center justify-center rounded-l-md px-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        [class.bg-primary]="density() === 'comfortable'"
        [class.text-on-primary]="density() === 'comfortable'"
        [class.text-default]="density() !== 'comfortable'"
        [class.hover:bg-surface-muted]="density() !== 'comfortable'"
      >
        <ui-icon name="bars-3" [size]="18" />
      </button>
      <button
        type="button"
        aria-label="Compact rows"
        [attr.aria-pressed]="density() === 'compact'"
        (click)="densityChange.emit('compact')"
        class="inline-flex min-h-11 items-center justify-center rounded-r-md border-l border-control px-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        [class.bg-primary]="density() === 'compact'"
        [class.text-on-primary]="density() === 'compact'"
        [class.text-default]="density() !== 'compact'"
        [class.hover:bg-surface-muted]="density() !== 'compact'"
      >
        <ui-icon name="bars-4" [size]="18" />
      </button>
    </div>
  `,
})
export class DensityToggle {
  readonly density = input<Density>('comfortable');
  readonly ariaLabel = input('Row density');
  readonly densityChange = output<Density>();
}
