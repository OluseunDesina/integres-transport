import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Styling shell only — border/spacing/horizontal-scroll wrapper around a
 * projected `<table>`. Not a column-def-driven grid: each screen still
 * writes its own `<thead>`/`<tbody>` with `@for` inside it. See
 * docs/specs/2-client-admin-super-admin-ui.md §4 for why (cheaper than
 * `@angular/cdk/table` for a handful of consumers with no sorting/
 * filtering need).
 *
 * The wrapper's `overflow-x-auto` scroll mechanism has worked correctly
 * since Phase 2 (verified live via scrollWidth/clientWidth on every
 * table that's ever exceeded its viewport), but carried zero visible
 * hint that a table scrolls — Phase 2's self-check found this on the
 * KYC/KYB queues and judged it minor/deferred; Phase 3's self-check hit
 * it a third time on `Trips`' 8-column table, wide enough to hide the
 * row's own action button even at the 1440px authoritative viewport.
 * Fixed at the root here with a CSS-only "scroll shadow" (no JS,
 * `background-attachment: local` vs `scroll` layering) so every table
 * in the app gets a left/right fade the instant it can be scrolled
 * further in that direction, and the fade disappears at each scroll
 * extent — not just Trips.
 *
 * **`stickyHeader` needs `maxHeight`, and that is not a style choice.**
 * The wrapper is `overflow-x: auto`, and CSS forces the other axis to
 * `auto` too — so the wrapper is already a scroll container, and
 * `position: sticky` on a `<th>` inside it sticks to *the wrapper*, not
 * the viewport. With no height constraint the wrapper never scrolls
 * vertically, so a sticky header would compile, pass a class-list
 * assertion, and visibly do nothing. Turning the feature on therefore
 * means giving the table its own bounded scroll region.
 *
 * Off by default, so no existing consumer changes shape.
 *
 * ## Responsive columns — a convention this component cannot enforce
 *
 * Every table in this workspace overflowed a 390px viewport, recorded
 * three times without a fix (`docs/ui-review/14-design-system/`
 * iteration-2 F5, iteration-4 F3, iteration-6 F5). The wrapper's
 * horizontal scroll did work — it just meant the row's only control was
 * off-screen, which is not a usable phone screen.
 *
 * The fix lives in the consumers, because this component projects a
 * table rather than owning its columns (see above). Three tiers:
 *
 * - **Always visible**: the primary identifier, the status, and every
 *   column containing a control. Never hide a column with a control in
 *   it — that is the defect, not a symptom of it.
 * - **`hidden md:table-cell`**: secondary data. Its values re-flow into
 *   a `md:hidden` sub-line under the primary cell, so a narrow row
 *   loses columns, not information.
 * - **`hidden lg:table-cell`**: the long tail, on tables wide enough to
 *   need a third tier. Reachable through the row's detail drawer, which
 *   is the universal fallback.
 *
 * `md` is Tailwind's 768px, matching `NavShell`'s own
 * `COLLAPSE_BREAKPOINT`, so the console changes shape at one width.
 *
 * **The class goes on the `<th>`, its matching `<td>`, and the matching
 * skeleton `<td>`.** Miss one and every later cell shifts into the
 * wrong column — silently: the page renders and nothing throws.
 * `expectColumnVisibilityParity` (`@shared-ui`, `lib/testing/`) is the
 * guard; call it from the list's spec, and
 * `e2e/responsive-tables.ts` measures the result at real widths.
 *
 * **Cells must not set their own horizontal padding.** This component
 * owns it, because it has to shrink on a phone — see the stylesheet
 * below. Vertical padding stays with the consumer: that is what the
 * density toggle changes.
 */
@Component({
  selector: 'ui-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // `min-w-0`: this component owns its own horizontal scroll (the
  // `overflow-x-auto` wrapper below), but a flex item's automatic
  // minimum size defaults to its content's min-content width — so
  // inside any `flex`/`flex-col` ancestor (every consumer here uses one:
  // `<div class="flex flex-col gap-6">`), the table's own un-shrinkable
  // content silently forced the *ancestor* wider instead of ever
  // reaching this wrapper's scroll behaviour. Invisible until spec 21
  // slice 3's Senior Mode grew a row's content past 390px for the first
  // time and turned it into real page-level horizontal overflow.
  host: { class: 'block min-w-0' },
  template: `
    <div
      class="relative overflow-x-auto rounded-md border border-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      tabindex="0"
      [attr.role]="label() ? 'region' : null"
      [attr.aria-label]="label()"
      [style.max-height]="stickyHeader() ? maxHeight() : null"
      style="background-color: var(--color-surface); background-repeat: no-repeat; background-attachment: local, local, scroll, scroll; background-size: 24px 100%, 24px 100%, 10px 100%, 10px 100%; background-image: linear-gradient(to right, var(--color-surface) 30%, transparent), linear-gradient(to left, var(--color-surface) 30%, transparent), linear-gradient(to right, rgba(15, 23, 42, 0.18), rgba(15, 23, 42, 0)), linear-gradient(to left, rgba(15, 23, 42, 0.18), rgba(15, 23, 42, 0)); background-position: left center, right center, left center, right center;"
    >
      @if (loading()) {
        <div class="p-8 text-center text-sm text-muted">Loading…</div>
      } @else if (empty()) {
        <div class="p-8 text-center text-sm text-muted">{{ emptyMessage() }}</div>
      } @else {
        <!-- text-sm, deliberately: this is the one primitive that does
             NOT read --ui-text-body (spec 14 slice 5 switched
             button/text-field/select/alert/empty-state/paginator over).
             A data grid is the one place density beats size. The
             responsive-tables slice measured and guarded these tables'
             fit at 390px at 14px, and e2e/responsive-tables.ts is what
             proves it still holds; growing every cell to 16px on
             customer-app would reopen exactly that. So the passenger
             app's tables stay at console density while its forms and
             buttons do not. -->
        <table class="w-full text-left text-sm" [class.ui-table-sticky]="stickyHeader()">
          <ng-content />
        </table>
      }
    </div>
  `,
  // Deep selectors, because every consumer writes its own `<thead>` —
  // this component projects a table rather than owning its rows (see the
  // docstring). `:host ::ng-deep` is scoped to this component's own
  // rendered subtree, so it cannot leak into a caller's other markup.
  //
  // The background is repeated on the cells: a sticky `<th>` scrolls
  // over the rows beneath it, and a transparent one lets them show
  // through.
  styles: [
    `
      :host ::ng-deep table.ui-table-sticky thead th {
        position: sticky;
        top: 0;
        z-index: 1;
        background-color: var(--color-surface);
      }

      /*
       * Horizontal cell padding is owned here, not by each consumer,
       * and it is responsive.
       *
       * Three columns of \`px-4\` spend 96px on padding alone. On a
       * 390px phone, behind the console's 64px collapsed icon rail,
       * that was measurably the difference between a table that fits
       * and one that still needs sideways scroll — 48px of overflow on
       * the routes list after the column tiers had already done their
       * work. Consumers set vertical padding (that is what the density
       * toggle changes) and leave this alone.
       *
       * \`overflow-wrap\` for the same reason: a cell holding an
       * unbroken token — a long reference, an email, a generated route
       * name — sets the column's minimum width to that token, and no
       * amount of column-hiding recovers it.
       */
      :host ::ng-deep table th,
      :host ::ng-deep table td {
        padding-inline: 0.5rem;
      }

      :host ::ng-deep table td {
        overflow-wrap: anywhere;
      }

      /*
       * ...but not inside a control. Applied to the whole cell it also
       * broke the row's own action button: "Review" rendered as three
       * stacked characters in the super-admin KYB queue at 390px, which
       * is worse than the overflow it was there to prevent. A label is
       * not the long value this is aimed at.
       */
      :host ::ng-deep table td :is(button, a) {
        overflow-wrap: normal;
      }

      /*
       * ...and not in a header either, which is why the rule above is
       * \`td\` alone.
       *
       * A header is a short, known string the app chose; a cell holds
       * whatever the data is. Breaking one mid-word buys nothing and
       * costs legibility: the KYB queue rendered "VERTIC AL",
       * "DIRECTO RS" and "DOCUMEN TS" at 1200px, because a narrow
       * column made each header longer than its own width
       * (iteration-17). \`break-word\` still rescues a genuinely
       * pathological header without splitting an ordinary one.
       */
      :host ::ng-deep table th {
        overflow-wrap: break-word;
      }

      @media (width >= 48rem) {
        :host ::ng-deep table th,
        :host ::ng-deep table td {
          padding-inline: 1rem;
        }
      }

      /*
       * Senior Mode (docs/specs/21-passenger-experience.md slice 3) only
       * ever sets \`data-senior\` on \`customer-app\`'s \`<html>\` — this
       * rule is therefore inert on every \`client-admin-app\`/
       * \`super-admin-app\` table, which keeps the console density
       * decision above (\`text-sm\`, never \`--ui-text-body\`) completely
       * untouched.
       *
       * \`overflow-wrap: anywhere\` above exists so one unbroken token
       * (a reference, an email) doesn't force a column wider than the
       * viewport — but it applies indiscriminately, and Senior Mode's
       * 175% root scale is what first made that cost visible: a genuinely
       * short, space-separated primary value ("QR code") fragmented
       * mid-word ("QR" / "cod" / "e") because \`anywhere\` breaks
       * wherever the box runs out of room, not at the word boundary that
       * was available. \`normal\` still wraps at the space — it only
       * stops manufacturing a break where none is needed — so this is a
       * strict improvement for exactly the tokens \`anywhere\` was never
       * needed for. A genuinely long unbroken token in a primary cell
       * (rare — most of those live in secondary/hidden columns) falls
       * back to the wrapper's own horizontal scroll, the same fallback
       * every table already relies on.
       */
      :host-context([data-senior='true']) ::ng-deep table td:not(:has(button, a)) {
        overflow-wrap: normal;
      }
    `,
  ],
})
export class Table {
  readonly loading = input(false);
  readonly empty = input(false);
  readonly emptyMessage = input('No results.');
  /**
   * Names the scroll container, which is a tab stop.
   *
   * The wrapper is `overflow: auto` in both axes, and `stickyHeader`
   * bounds its height, so it genuinely scrolls — and a scrollable
   * region with no focusable content inside cannot be scrolled from the
   * keyboard at all (WCAG 2.1.1; axe's `scrollable-region-focusable`,
   * which is how this was found, intermittently, on a filtered trips
   * list whose only rows had scrolled away). `tabindex="0"` fixes that,
   * but an unnamed tab stop announces nothing — so pass a label and the
   * container becomes a named region instead of an anonymous one.
   */
  readonly label = input<string | null>(null);
  /**
   * Pins the header while the rows scroll. Requires a bounded height —
   * see the class docstring for why that is a consequence rather than a
   * preference.
   */
  readonly stickyHeader = input(false);
  /**
   * The bounded scroll region's height. Viewport-relative by default so
   * a tall screen shows more rows; ignored unless `stickyHeader` is on.
   */
  readonly maxHeight = input('70vh');
}
