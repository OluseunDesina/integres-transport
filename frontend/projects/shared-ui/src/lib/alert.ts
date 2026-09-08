import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'ui-alert',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div
      [attr.role]="role()"
      style="font-size: var(--ui-text-body)"
      class="rounded-md border px-3 py-2"
      [class.border-danger-border]="variant() === 'error'"
      [class.bg-danger-surface]="variant() === 'error'"
      [class.text-danger]="variant() === 'error'"
      [class.border-success-border]="variant() === 'success'"
      [class.bg-success-surface]="variant() === 'success'"
      [class.text-success]="variant() === 'success'"
      [class.border-warning-border]="variant() === 'warning'"
      [class.bg-warning-surface]="variant() === 'warning'"
      [class.text-warning]="variant() === 'warning'"
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

  /**
   * The role follows the variant rather than being fixed at `alert`.
   *
   * `role="alert"` is an *assertive* live region: it interrupts a
   * screen reader mid-sentence. That is right for a failure the user
   * must deal with, and wrong for "Saved." — and wrong again for the
   * static guidance several screens render through this component,
   * which interrupted on every page load. `status` is the polite
   * equivalent and is what a confirmation or a heads-up should use.
   */
  protected readonly role = computed(() => (this.variant() === 'error' ? 'alert' : 'status'));
}
