import { todayIso } from './dates';

/**
 * The passenger's last few searches, kept in this browser only —
 * docs/specs/24-marketplace-redesign.md (Omio, Busbud and Trainline all
 * offer one-tap repeats of a recent search). A per-viewer convenience,
 * never state anything relies on: every read and write is wrapped, and a
 * private window or blocked storage simply shows no chips.
 */
export interface RecentSearch {
  origin: string;
  destination: string;
  serviceDate: string;
  tripClass: string;
}

const STORAGE_KEY = 'marketplace.recentSearches';
export const MAX_RECENT_SEARCHES = 4;

export function readRecentSearches(storage: Storage | null = safeStorage()): RecentSearch[] {
  if (!storage) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (row): row is RecentSearch =>
          !!row &&
          typeof row.origin === 'string' &&
          typeof row.destination === 'string' &&
          typeof row.serviceDate === 'string' &&
          typeof row.tripClass === 'string'
      )
      .slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
}

/** Newest first; one entry per origin/destination pair, so searching the
 * same route on another day replaces rather than duplicates it. */
export function saveRecentSearch(search: RecentSearch, storage: Storage | null = safeStorage()): void {
  if (!storage) {
    return;
  }
  const key = routeKey(search);
  const next = [search, ...readRecentSearches(storage).filter((row) => routeKey(row) !== key)].slice(
    0,
    MAX_RECENT_SEARCHES
  );
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota or blocked storage — the chips are a convenience, not state.
  }
}

/** A remembered date that has since passed is rolled forward to today:
 * nothing can be booked in the past. */
export function searchDateFor(search: RecentSearch, today: string = todayIso()): string {
  return search.serviceDate < today ? today : search.serviceDate;
}

function routeKey(search: RecentSearch): string {
  return `${search.origin.toLowerCase()}→${search.destination.toLowerCase()}`;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
