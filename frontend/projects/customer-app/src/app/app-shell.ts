import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthApiService, AuthStore } from '@auth';

/**
 * Authenticated chrome for the passenger app — see
 * docs/specs/4-fares-seating-booking-frontend.md §4.1.
 *
 * `DECISION` (from that spec): a customer-app-specific top bar rather
 * than reusing `@layout`'s `NavShell`. NavShell's collapsible sidebar,
 * business switcher and role/permission-filtered nav are staff
 * back-office chrome; a consumer-facing app with two destinations
 * shouldn't look like an admin console. There is no permission
 * filtering here either — passengers hold no Role/Permission
 * (docs/adr/0003), so every link in this bar is reachable by every
 * signed-in passenger, and the `customer:access` guard on the child
 * routes is the only gate.
 *
 * Note this component carries no guard of its own, matching NavShell's
 * own documented posture: it is layout, not an access gate, and each
 * child route keeps its own `canActivate: [permissionGuard]`.
 */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-screen flex-col bg-slate-50' },
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex h-14 max-w-4xl items-center gap-6 px-4">
        <a
          routerLink="/home"
          class="shrink-0 rounded-md text-sm font-semibold text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
        >
          Integra Travel
        </a>

        <nav role="navigation" aria-label="Primary" class="flex min-w-0 flex-1 items-center gap-1">
          <a
            routerLink="/search"
            routerLinkActive="bg-slate-100 text-slate-900 font-medium"
            #searchLink="routerLinkActive"
            [attr.aria-current]="searchLink.isActive ? 'page' : null"
            class="inline-flex min-h-11 items-center rounded-md px-3 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900"
          >
            Search trips
          </a>
          <a
            routerLink="/my-bookings"
            routerLinkActive="bg-slate-100 text-slate-900 font-medium"
            #bookingsLink="routerLinkActive"
            [attr.aria-current]="bookingsLink.isActive ? 'page' : null"
            class="inline-flex min-h-11 items-center rounded-md px-3 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900"
          >
            My bookings
          </a>
          <a
            routerLink="/credentials"
            routerLinkActive="bg-slate-100 text-slate-900 font-medium"
            #credentialsLink="routerLinkActive"
            [attr.aria-current]="credentialsLink.isActive ? 'page' : null"
            class="inline-flex min-h-11 items-center rounded-md px-3 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900"
          >
            Tap &amp; Go
          </a>
        </nav>

        <button
          type="button"
          (click)="signOut()"
          class="inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
        >
          Sign out
        </button>
      </div>
    </header>

    <main class="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
      <router-outlet />
    </main>
  `,
})
export class AppShell {
  protected readonly authStore = inject(AuthStore);
  private readonly authApi = inject(AuthApiService);
  private readonly router = inject(Router);

  protected async signOut(): Promise<void> {
    this.authApi.logout();
    await this.router.navigate(['/login']);
  }
}
