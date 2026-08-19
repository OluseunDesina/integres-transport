import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthApiService, AuthStore } from '@auth';
import { Button } from '@shared-ui';

/**
 * A bespoke minimal top-bar shell, not `@layout`'s `NavShell` — NavShell
 * is built for a multi-section back-office console (collapsible
 * sidebar, business switcher, a dozen nav items); this app has exactly
 * two screens (`/record`, `/validate-ticket`), so a couple of plain
 * `routerLink`s in the header cover it — still not the sidebar chrome
 * NavShell exists for. `AuthStore`/`AuthApiService` are still the
 * shared `@auth` primitives — only the chrome around them is
 * app-specific. Both links render unconditionally rather than behind
 * `*appHasPermission`: each route already has its own `permissionGuard`,
 * and `tapngo.record`/`ticketing.validate` are always granted together
 * in `DEFAULT_ROLE_PERMISSIONS`, so a validator-app user who can reach
 * one screen can always reach the other.
 */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Button],
  host: { class: 'flex min-h-screen flex-col bg-slate-50' },
  template: `
    <header
      class="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4"
    >
      <div class="flex items-center gap-6">
        <span class="text-sm font-semibold text-slate-900">Integra Validator</span>
        <nav class="flex items-center gap-4 text-sm">
          <a
            routerLink="/record"
            routerLinkActive="font-semibold text-slate-900"
            class="text-slate-500 hover:text-slate-900"
          >
            Record tap
          </a>
          <a
            routerLink="/validate-ticket"
            routerLinkActive="font-semibold text-slate-900"
            class="text-slate-500 hover:text-slate-900"
          >
            Validate ticket
          </a>
        </nav>
      </div>
      <div class="flex items-center gap-3">
        <span class="hidden truncate text-sm text-slate-500 sm:inline">{{
          authStore.user()?.email
        }}</span>
        <ui-button variant="secondary" (pressed)="signOut()">Sign out</ui-button>
      </div>
    </header>

    <main class="min-w-0 flex-1 overflow-y-auto p-4">
      <div class="mx-auto max-w-lg">
        <router-outlet />
      </div>
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
