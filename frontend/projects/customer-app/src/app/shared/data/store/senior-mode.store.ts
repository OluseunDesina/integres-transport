import { DOCUMENT } from '@angular/common';
import { Injectable, effect, inject, signal } from '@angular/core';

const STORAGE_KEY = 'integra.senior-mode';

/**
 * Persists the passenger's Senior Mode preference and reflects it onto
 * the document root — docs/specs/21-passenger-experience.md slice 3.
 *
 * Same restore/persist shape as `@layout`'s `NavCollapseStore`, plus the
 * one thing that store never needed: writing to the DOM. `data-senior`
 * on `<html>` is what every token override in `theme.css` keys off, so
 * this is the one place in `customer-app` that sets it — no component
 * branches on the mode in TypeScript, per the spec's own "what it must
 * not do".
 *
 * `customer-app`-local rather than `@shared-ui`: the brief scopes Senior
 * Mode to passengers, and putting the *store* in a library shared with
 * three operator apps that must never gain this mode would be an easy
 * place for it to leak in by accident.
 */
@Injectable({ providedIn: 'root' })
export class SeniorModeStore {
  private readonly document = inject(DOCUMENT);
  private readonly enabledSignal = signal<boolean>(this.restore());

  readonly enabled = this.enabledSignal.asReadonly();

  constructor() {
    // Runs once for the restored value and again on every toggle() —
    // the single point where the preference becomes the attribute every
    // `[data-senior='true']` rule in theme.css selects on.
    effect(() => {
      if (this.enabledSignal()) {
        this.document.documentElement.setAttribute('data-senior', 'true');
      } else {
        this.document.documentElement.removeAttribute('data-senior');
      }
    });
  }

  toggle(): void {
    this.set(!this.enabledSignal());
  }

  set(value: boolean): void {
    this.enabledSignal.set(value);
    this.persist(value);
  }

  /**
   * Never throws, per the spec's own edge case: `localStorage`
   * unavailable or blocked must default off, not crash the app.
   * `getItem` itself (not just being missing) can throw in a browser
   * that blocks storage access entirely, which a bare `typeof`-guard
   * would not catch.
   */
  private restore(): boolean {
    try {
      if (typeof localStorage === 'undefined') {
        return false;
      }
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw != null && (JSON.parse(raw) as boolean) === true;
    } catch {
      return false;
    }
  }

  private persist(value: boolean): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      }
    } catch {
      // Blocked or full — the toggle still works for the session, per
      // the spec's edge case; it just won't survive a reload.
    }
  }
}
