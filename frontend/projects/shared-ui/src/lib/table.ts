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
 */
@Component({
  selector: 'ui-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div
      class="overflow-x-auto rounded-md border border-slate-200"
      style="background-color: white; background-repeat: no-repeat; background-attachment: local, local, scroll, scroll; background-size: 24px 100%, 24px 100%, 10px 100%, 10px 100%; background-image: linear-gradient(to right, white 30%, rgba(255, 255, 255, 0)), linear-gradient(to left, white 30%, rgba(255, 255, 255, 0)), linear-gradient(to right, rgba(15, 23, 42, 0.18), rgba(15, 23, 42, 0)), linear-gradient(to left, rgba(15, 23, 42, 0.18), rgba(15, 23, 42, 0)); background-position: left center, right center, left center, right center;"
    >
      @if (loading()) {
        <div class="p-8 text-center text-sm text-slate-500">Loading…</div>
      } @else if (empty()) {
        <div class="p-8 text-center text-sm text-slate-500">{{ emptyMessage() }}</div>
      } @else {
        <table class="w-full text-left text-sm">
          <ng-content />
        </table>
      }
    </div>
  `,
})
export class Table {
  readonly loading = input(false);
  readonly empty = input(false);
  readonly emptyMessage = input('No results.');
}
