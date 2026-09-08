import { ChangeDetectionStrategy, Component, input } from '@angular/core';

let nextId = 0;

/**
 * The single `<h1>` for a screen, plus its description, breadcrumb and
 * actions. Before this existed, thirty-five screens each hand-wrote a
 * `<div class="flex items-center justify-between">` with an `<h1>` in
 * it, and they had drifted: different type sizes, different gaps,
 * actions on the left in some and the right in others.
 *
 * Breadcrumbs and actions are **content slots, not inputs**, and that is
 * deliberate. A breadcrumb is a list of `routerLink` anchors, and an
 * action is usually a permission-gated `ui-button`; taking either as
 * data would drag `@angular/router` and `@auth`'s
 * `*appHasPermission` into `@shared-ui`, which is a presentational
 * library with no application dependencies. The caller owns both and
 * this owns the layout.
 *
 * The description is associated with the heading via `aria-describedby`,
 * so a screen reader announcing the heading also announces what the
 * screen is for.
 */
@Component({
  selector: 'ui-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <header class="flex flex-col gap-2">
      <ng-content select="[breadcrumb]" />
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex flex-col gap-1">
          <h1
            [id]="titleId"
            [attr.aria-describedby]="description() ? descriptionId : null"
            class="font-semibold text-strong"
            style="font-size: var(--ui-text-heading)"
          >
            {{ title() }}
          </h1>
          @if (description(); as text) {
            <p
              [id]="descriptionId"
              style="font-size: var(--ui-text-body)"
              class="max-w-2xl text-muted"
            >
              {{ text }}
            </p>
          }
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <ng-content select="[actions]" />
        </div>
      </div>
    </header>
  `,
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly description = input<string | null>(null);

  protected readonly titleId = `ui-page-header-${nextId++}`;
  protected readonly descriptionId = `${this.titleId}-description`;
}
