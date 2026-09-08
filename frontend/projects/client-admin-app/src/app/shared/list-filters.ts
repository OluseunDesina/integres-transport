import { computed, signal } from '@angular/core';
import type { FilterChip, SelectOption } from '@shared-ui';

/** Rendered in every list's active/inactive filter. */
export const ACTIVE_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: 'All statuses' },
  { value: 'true', label: 'Active only' },
  { value: 'false', label: 'Inactive only' },
];

/**
 * What a screen merges into its store's query.
 *
 * `search` and `is_active` are declared rather than left to the index
 * signature so callers can read `query().search` — under a bare
 * `Record`, TypeScript requires `query()['search']` (TS4111) and every
 * slice-3a screen would have had to change for no gain.
 */
export interface ListFilterQuery extends Record<string, string | boolean | undefined> {
  search?: string;
  is_active?: boolean;
}

/**
 * One of a screen's own filters — a status, a route, a service date.
 *
 * `chipValue` is what the chip shows, and it exists because the value a
 * screen sends is rarely the value a person recognises: a route filter
 * sends a UUID and must read "Route: Ikeja Express". Defaulting the chip
 * to the raw value would have put UUIDs on screen.
 */
export interface ExtraFilterConfig {
  /** Query-param name, and the chip's id. */
  key: string;
  /** Chip label — "Status", "Route". */
  label: string;
  /** Human-readable value for the chip. Falls back to the raw value. */
  chipValue?: (value: string) => string;
}

/**
 * The filter state every `client-admin-app` list shares, and the chips
 * that make it visible.
 *
 * A plain class rather than an injectable: each list screen owns its own
 * instance, because a filter belongs to the screen a person is looking
 * at. (Density is the opposite — a preference about reading tables in
 * general — which is why `TableDensityStore` *is* root-provided.)
 *
 * The chips are the reason this is worth sharing. A list quietly showing
 * a subset, with nothing on screen saying so, is indistinguishable from
 * a list with no data — the confusion recorded against the KYB queue and
 * against `super-admin-app`'s "Business not found". Every filter that
 * narrows a list renders a chip that removes it, and one clear-all
 * empties every one of them without each screen re-deriving that.
 *
 * `search` is kept raw and trimmed only on the way out. Writing a
 * trimmed value back would feed `ui-filter-bar`'s own `[searchValue]`
 * and delete a trailing space the moment a user typed one, jumping their
 * cursor.
 *
 * Slice 3a modelled search plus `is_active`, which the six network/fleet
 * lists all share. Slice 3b's screens filter by status, route, schedule
 * and service date instead, so `extras` carries anything else a screen
 * declares — through the same chips and the same clear-all.
 */
export class ListFilters {
  readonly search = signal('');
  /** `''` means "no status filter", not "inactive". */
  readonly activeFilter = signal<'' | 'true' | 'false'>('');
  private readonly extras = signal<Record<string, string>>({});

  constructor(private readonly extraConfigs: readonly ExtraFilterConfig[] = []) {}

  /** What to merge into the store's query. Anything unset is `undefined`,
   * so the backend sees no param rather than an empty one. */
  readonly query = computed<ListFilterQuery>(() => {
    const query: ListFilterQuery = {
      search: this.search().trim() || undefined,
      is_active: this.activeFilter() === '' ? undefined : this.activeFilter() === 'true',
    };
    for (const config of this.extraConfigs) {
      query[config.key] = this.extras()[config.key] || undefined;
    }
    return query;
  });

  readonly chips = computed<FilterChip[]>(() => {
    const chips: FilterChip[] = [];
    const term = this.search().trim();
    if (term) {
      chips.push({ id: 'search', label: 'Search', value: term });
    }
    if (this.activeFilter() !== '') {
      chips.push({
        id: 'is_active',
        label: 'Status',
        value: this.activeFilter() === 'true' ? 'Active' : 'Inactive',
      });
    }
    for (const config of this.extraConfigs) {
      const value = this.extras()[config.key];
      if (value) {
        chips.push({
          id: config.key,
          label: config.label,
          value: config.chipValue ? config.chipValue(value) : value,
        });
      }
    }
    return chips;
  });

  /** True when the list a person is looking at is not the whole list —
   * used to word the empty state, which otherwise reads as "you have no
   * records" when it means "none match". */
  readonly isFiltered = computed(() => this.chips().length > 0);

  setSearch(value: string): void {
    this.search.set(value);
  }

  setActiveFilter(value: string): void {
    this.activeFilter.set(value === 'true' || value === 'false' ? value : '');
  }

  /** Current value of one of the screen's own filters, for binding back
   * into its control. */
  extra(key: string): string {
    return this.extras()[key] ?? '';
  }

  setExtra(key: string, value: string): void {
    this.extras.update((current) => ({ ...current, [key]: value }));
  }

  /** Removes one chip by the id it was rendered with. */
  remove(chipId: string): void {
    if (chipId === 'search') {
      this.search.set('');
    } else if (chipId === 'is_active') {
      this.activeFilter.set('');
    } else {
      this.setExtra(chipId, '');
    }
  }

  clear(): void {
    this.search.set('');
    this.activeFilter.set('');
    this.extras.set({});
  }
}
