import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type StatusPillTone = 'neutral' | 'positive' | 'warning' | 'negative';

@Component({
  selector: 'ui-status-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-block' },
  template: `
    <span
      class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
      [class.bg-slate-100]="tone() === 'neutral'"
      [class.text-slate-700]="tone() === 'neutral'"
      [class.bg-emerald-100]="tone() === 'positive'"
      [class.text-emerald-700]="tone() === 'positive'"
      [class.bg-amber-100]="tone() === 'warning'"
      [class.text-amber-700]="tone() === 'warning'"
      [class.bg-red-100]="tone() === 'negative'"
      [class.text-red-700]="tone() === 'negative'"
    >
      {{ label() }}
    </span>
  `,
})
export class StatusPill {
  readonly label = input.required<string>();
  readonly tone = input<StatusPillTone>('neutral');
}
