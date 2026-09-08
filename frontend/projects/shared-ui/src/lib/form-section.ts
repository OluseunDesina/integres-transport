import { ChangeDetectionStrategy, Component, input } from '@angular/core';

let nextId = 0;

/**
 * A titled, described grouping of related fields within a long form.
 *
 * A real `<section aria-labelledby>` rather than a styled `<div>`: it
 * puts the group into the landmark/heading outline, so a screen-reader
 * user can jump between "Vehicle details" and "Compliance" the way a
 * sighted user's eye does. `route-form` and `business-form` are long
 * enough that this is navigation, not decoration.
 *
 * The description is wired through `aria-describedby` on the section
 * itself — the same rule `ui-select`'s `hint` and `ui-toggle`'s
 * `describedBy` already record: a loose `<p>` beside a control reaches
 * sighted users only.
 */
@Component({
  selector: 'ui-form-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section
      [attr.aria-labelledby]="titleId"
      [attr.aria-describedby]="description() ? descriptionId : null"
      class="flex flex-col"
      style="gap: var(--ui-gutter)"
    >
      <div class="flex flex-col gap-1 border-b border-border pb-3">
        <h2 [id]="titleId" class="text-sm font-semibold text-strong">{{ title() }}</h2>
        @if (description(); as text) {
          <p [id]="descriptionId" class="text-sm text-muted">{{ text }}</p>
        }
      </div>
      <div class="flex flex-col" style="gap: var(--ui-gutter)">
        <ng-content />
      </div>
    </section>
  `,
})
export class FormSection {
  readonly title = input.required<string>();
  readonly description = input<string | null>(null);

  protected readonly titleId = `ui-form-section-${nextId++}`;
  protected readonly descriptionId = `${this.titleId}-description`;
}
