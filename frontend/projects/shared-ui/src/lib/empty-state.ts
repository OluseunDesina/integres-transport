import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'ui-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div
      class="flex flex-col items-center gap-2 rounded-md border border-dashed border-control p-8 text-center"
    >
      <h2 style="font-size: var(--ui-text-body)" class="font-medium text-strong">
        {{ title() }}
      </h2>
      @if (description()) {
        <p style="font-size: var(--ui-text-body)" class="text-muted">{{ description() }}</p>
      }
      <ng-content />
    </div>
  `,
})
export class EmptyState {
  readonly title = input.required<string>();
  readonly description = input<string | null>(null);
}
