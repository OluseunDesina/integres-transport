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
 *
 * **`min-w-0` on both flex wrappers, not decorative.** `break-words` on
 * the heading/description alone did nothing — a flex item's default
 * minimum width is its content's own min-content size, which for
 * wrappable prose is the width of its single widest *unbreakable* run
 * (an email address, say). Without `min-w-0` these two columns simply
 * grew to fit that run instead of ever handing `break-words` a
 * constrained box to break inside, so a long `title()` overflowed
 * `customer-app`'s `<main>` instead of wrapping — caught by spec 21
 * slice 3's Senior Mode, whose larger type made an existing safe fit
 * (a passenger's own email, `home.ts`'s greeting) exceed 390px for the
 * first time (docs/ui-review/21-passenger-experience/iteration-1.md).
 */
@Component({
  selector: 'ui-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <header class="flex flex-col gap-2">
      <ng-content select="[breadcrumb]" />
      <div class="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div class="flex min-w-0 flex-col gap-1">
          <h1
            [id]="titleId"
            [attr.aria-describedby]="description() ? descriptionId : null"
            class="break-words font-semibold text-strong"
            style="font-size: var(--ui-text-heading)"
          >
            {{ title() }}
          </h1>
          @if (description(); as text) {
            <p
              [id]="descriptionId"
              style="font-size: var(--ui-text-body)"
              class="max-w-2xl break-words text-muted"
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
