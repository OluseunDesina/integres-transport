import { Injectable, computed, signal } from '@angular/core';

const STORAGE_KEY = 'integra.nav.collapsed';

/**
 * Persists the user's manual sidebar-collapse preference — mirrors
 * AuthStore's restore/persist shape exactly. This store only tracks the
 * *manual* preference. Viewport-driven auto-collapse below NavShell's
 * responsive breakpoint is a separate, transient override composed in
 * NavShell itself (via CDK BreakpointObserver) — it never touches or
 * clobbers this persisted value, so widening the viewport back past the
 * breakpoint reverts to whatever was last manually chosen.
 */
@Injectable({ providedIn: 'root' })
export class NavCollapseStore {
  private readonly manuallyCollapsed = signal<boolean>(this.restore());

  readonly collapsed = computed(() => this.manuallyCollapsed());

  toggle(): void {
    const next = !this.manuallyCollapsed();
    this.manuallyCollapsed.set(next);
    this.persist(next);
  }

  private restore(): boolean {
    if (typeof localStorage === 'undefined') {
      return false;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return false;
    }
    try {
      return (JSON.parse(raw) as boolean) === true;
    } catch {
      return false;
    }
  }

  private persist(value: boolean): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    }
  }
}
