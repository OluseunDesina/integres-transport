import { Injectable, signal } from '@angular/core';
import type { Density } from '@shared-ui';

const STORAGE_KEY = 'integra:table-density';

/**
 * The operator's comfortable/compact preference for data tables.
 *
 * One store, one key, every list — not a per-screen signal. Density is a
 * preference about how someone reads a table, not a filter on one screen:
 * an operator who wants dense rows wants them on drivers as much as on
 * vehicles, and having each list remember its own would feel broken.
 *
 * Introduced in spec 14 slice 3a. Slice 2 had this logic inline in
 * `vehicle-list.ts`, which was fine for one consumer and would have been
 * copy-paste across six.
 *
 * Kept in `client-admin-app` rather than promoted to `@shared-data`,
 * which is a data-fetching library (`ListStore`), not a UI-preference
 * one. If `super-admin-app` wants the same in slice 6, twenty lines
 * duplicated once is cheaper than inventing library API for it now.
 */
@Injectable({ providedIn: 'root' })
export class TableDensityStore {
  private readonly state = signal<Density>(read());

  readonly density = this.state.asReadonly();

  set(next: Density): void {
    this.state.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A preference that cannot be persisted is still worth honouring
      // for this session.
    }
  }
}

function read(): Density {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    // Private browsing and blocked site data both throw on access.
    return 'comfortable';
  }
}
