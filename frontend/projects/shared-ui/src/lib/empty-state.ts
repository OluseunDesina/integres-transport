import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'ui-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div
      class="flex flex-col items-center gap-2 rounded-md border border-dashed border-slate-300 p-8 text-center"
    >
      <h2 class="text-sm font-medium text-slate-900">{{ title() }}</h2>
      @if (description()) {
        <p class="text-sm text-slate-500">{{ description() }}</p>
      }
      <ng-content />
    </div>
  `,
})
export class EmptyState {
  readonly title = input.required<string>();
  readonly description = input<string | null>(null);
}
