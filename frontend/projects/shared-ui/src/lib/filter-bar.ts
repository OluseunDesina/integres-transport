import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, output } from '@angular/core';

import { Button } from './button';
import { Icon } from './icon';

let nextId = 0;

export interface FilterChip {
  /** Opaque to this component; echoed back on `chipRemoved`. */
  id: string;
  /** What the filter is — "Status". */
  label: string;
  /** What it is set to — "Active". */
  value: string;
}

/**
 * Search, filter controls and the active-filter chips that say what is
 * currently being hidden.
 *
 * The chips are the reason this exists as a component rather than a
 * layout convention. Several lists in this console filter by a value
 * chosen on a *different* screen (the selected Business, a status
 * carried in from a queue), and a list that silently shows a subset with
 * nothing on screen saying so is indistinguishable from a list with no
 * data — which is precisely the confusion recorded against the KYB queue
 * and the trip dropdown. A chip per active filter, and one way to clear
 * them all.
 *
 * Search is **debounced here**, not by each caller. Every list store
 * refetches on `updateQuery`, so an undebounced search box is one HTTP
 * request per keystroke against a paginated endpoint. Callers that want
 * raw keystrokes can set `debounceMs` to 0.
 *
 * `role="search"` makes the whole strip a landmark, so a keyboard user
 * can jump straight to it.
 */
@Component({
  selector: 'ui-filter-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [Button, Icon],
  template: `
    <div role="search" [attr.aria-label]="ariaLabel()" class="flex flex-col gap-3">
      <div class="flex flex-wrap items-end gap-3">
        @if (showSearch()) {
        <!-- Capped, not free-growing. On a 1200px console an uncapped
             search box is a 900px input, which reads as the page's main
             field rather than as a filter for the table under it. -->
        <div class="flex w-full max-w-sm min-w-56 flex-col gap-1">
          <!-- Visible, not screen-reader-only. Slice 3a recorded this as
               F2: the status filter beside it renders a real label, so a
               hidden one here left the two controls sitting at different
               heights. With three or four controls in the bar (slice
               3b's screens) that stops being cosmetic and starts reading
               as a broken layout. -->
          <label [for]="searchId" class="text-sm font-medium text-default">{{
            searchLabel()
          }}</label>
          <div class="relative">
            <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
              <ui-icon name="magnifying-glass" [size]="18" />
            </span>
            <input
              [id]="searchId"
              type="search"
              [value]="searchValue()"
              [placeholder]="placeholder()"
              (input)="onSearchInput($event)"
              class="w-full rounded-md border border-control bg-surface py-2 pr-3 pl-10 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              style="min-height: var(--ui-control-height)"
            />
          </div>
        </div>
        }
        <ng-content select="[filters]" />
      </div>

      @if (chips().length > 0) {
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs font-medium tracking-wide text-muted uppercase">Filters</span>
          @for (chip of chips(); track chip.id) {
            <button
              type="button"
              (click)="chipRemoved.emit(chip.id)"
              class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-sunken py-1 pr-1.5 pl-2.5 text-xs font-medium text-default hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              [attr.aria-label]="'Remove filter ' + chip.label + ': ' + chip.value"
            >
              <span>{{ chip.label }}: {{ chip.value }}</span>
              <ui-icon name="x-mark" [size]="14" />
            </button>
          }
          @if (showClearAll()) {
            <ui-button variant="secondary" (pressed)="cleared.emit()">Clear all</ui-button>
          }
        </div>
      }
    </div>
  `,
})
export class FilterBar {
  private readonly destroyRef = inject(DestroyRef);

  readonly searchValue = input('');
  readonly searchLabel = input('Search');
  readonly placeholder = input('Search…');
  readonly ariaLabel = input('Filters');
  readonly chips = input<FilterChip[]>([]);
  readonly debounceMs = input(300);
  /**
   * Whether to render the search input at all.
   *
   * Set `false` on a list whose endpoint has no free-text filter. A
   * search box that silently ignores what is typed into it is worse
   * than no search box — it is the same "looks like it worked" failure
   * this component's chips exist to prevent, and the pay-as-you-go
   * journeys screen shipped exactly that for one iteration of spec 14
   * slice 3b before the visual pass caught it.
   */
  readonly showSearch = input(true);

  readonly searchChange = output<string>();
  readonly chipRemoved = output<string>();
  readonly cleared = output<void>();

  protected readonly searchId = `ui-filter-bar-${nextId++}`;

  /** One chip needs no "clear all" — its own remove button is that. */
  protected readonly showClearAll = computed(() => this.chips().length > 1);

  private debounceHandle: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // A pending debounce after the screen is gone would emit into a
    // destroyed component's output.
    this.destroyRef.onDestroy(() => {
      if (this.debounceHandle !== null) {
        clearTimeout(this.debounceHandle);
      }
    });
  }

  protected onSearchInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;

    if (this.debounceHandle !== null) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }

    const delay = this.debounceMs();
    if (delay <= 0) {
      this.searchChange.emit(value);
      return;
    }

    this.debounceHandle = setTimeout(() => {
      this.debounceHandle = null;
      this.searchChange.emit(value);
    }, delay);
  }
}
