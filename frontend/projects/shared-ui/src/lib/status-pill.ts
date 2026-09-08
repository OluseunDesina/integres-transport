import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type StatusPillTone = 'neutral' | 'positive' | 'warning' | 'negative';

@Component({
  selector: 'ui-status-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-block' },
  template: `
    <span
      class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"
      [class.bg-surface-sunken]="tone() === 'neutral'"
      [class.text-default]="tone() === 'neutral'"
      [class.bg-success-surface]="tone() === 'positive'"
      [class.text-success]="tone() === 'positive'"
      [class.bg-warning-surface]="tone() === 'warning'"
      [class.text-warning]="tone() === 'warning'"
      [class.bg-danger-surface]="tone() === 'negative'"
      [class.text-danger]="tone() === 'negative'"
    >
      {{ label() }}
    </span>
  `,
})
export class StatusPill {
  readonly label = input.required<string>();
  readonly tone = input<StatusPillTone>('neutral');
}
