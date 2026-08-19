import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A single labelled figure (a balance, a count, a total) — the one
 * shared-ui gap every read-only "visibility" screen since Phase 2 has
 * hand-rolled around instead of reusing (confirmed by grep: zero prior
 * card/stat component anywhere in the workspace). Presentational only,
 * same OnPush/slate-palette/rounded-md convention as `EmptyState`.
 */
@Component({
  selector: 'ui-stat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="rounded-md border border-slate-200 bg-white p-4">
      <p class="text-xs font-medium uppercase tracking-wide text-slate-500">{{ label() }}</p>
      <p class="mt-1 text-2xl font-semibold text-slate-900"><ng-content /></p>
      @if (hint()) {
        <p class="mt-1 text-sm text-slate-500">{{ hint() }}</p>
      }
    </div>
  `,
})
export class Stat {
  readonly label = input.required<string>();
  readonly hint = input<string | null>(null);
}
