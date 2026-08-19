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
    >
      <ng-content />
    </div>
  `,
})
export class Alert {
  readonly variant = input<'error' | 'success'>('error');
}
