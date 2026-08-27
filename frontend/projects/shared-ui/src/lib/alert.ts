import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'ui-alert',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div
      role="alert"
      class="rounded-md border px-3 py-2 text-sm"
      [class.border-red-200]="variant() === 'error'"
      [class.bg-red-50]="variant() === 'error'"
      [class.text-red-700]="variant() === 'error'"
      [class.border-emerald-200]="variant() === 'success'"
      [class.bg-emerald-50]="variant() === 'success'"
      [class.text-emerald-700]="variant() === 'success'"
      [class.border-amber-200]="variant() === 'warning'"
      [class.bg-amber-50]="variant() === 'warning'"
      [class.text-amber-800]="variant() === 'warning'"
    >
      <ng-content />
    </div>
  `,
})
export class Alert {
  /**
   * `warning` is for a state the user can act on that is not itself a
   * failure — a Business priced flat while looking at its per-segment
   * fare grid, say. Distinct from `error` because nothing has gone
   * wrong yet; colouring it red would train people to ignore red.
   */
  readonly variant = input<'error' | 'success' | 'warning'>('error');
}
