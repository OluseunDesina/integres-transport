import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthApiService, AuthStore, PermissionsService } from '@auth';
import { BrandMark, NotificationBell } from '@layout';
import { Button } from '@shared-ui';

/**
 * A bespoke minimal top-bar shell, not `@layout`'s `NavShell` — NavShell
 * is built for a multi-section back-office console (collapsible
 * sidebar, business switcher, a dozen nav items); this app has three
 * screens (`/record`, `/validate-ticket`, `/report-issue`), so a few
 * plain `routerLink`s in the header cover it — still not the sidebar
 * chrome NavShell exists for. `AuthStore`/`AuthApiService` are still
 * the shared `@auth` primitives — only the chrome around them is
 * app-specific.
 *
 * **The first two links render unconditionally; the third does not.**
 * `tapngo.record` and `ticketing.validate` are always granted together
 * in `DEFAULT_ROLE_PERMISSIONS`, so a user who can reach one of those
 * screens can always reach the other, and filtering them would be
 * ceremony. `incidents.manage` (spec 17 slice 3) is a separate codename
 * a custom Role can omit while still granting the tapping two — see
 * `visibleNavLinks`.
 */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, BrandMark, Button, NotificationBell],
  host: { class: 'flex min-h-screen flex-col bg-surface-muted' },
  template: `
    <!-- The nav takes its own full-width row below \`sm\`, exactly as
         customer-app's header does and for the same reason: a mark, a
         wordmark, the nav links, a bell and Sign out do not fit 390px on
         one row. They wrapped mid-label ("Record / tap", "Sign / out")
         once slice 6b flipped this app to the consumer profile and every
         control grew — recorded as F1 in iteration-20. -->
    <header
      class="flex min-h-14 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-surface px-4 py-2 sm:flex-nowrap sm:justify-between sm:py-0"
    >
      <!-- The operator's mark plus "Validator": a conductor must be
           able to tell this app from the passenger one at a glance,
           and a tenant logo alone cannot say which it is. -->
      <span class="flex shrink-0 items-center gap-2">
        <app-brand-mark [height]="24" />
        <span class="text-sm font-semibold text-muted">Validator</span>
      </span>
      <!-- A direct child of the header, not nested inside a
           \`flex-1\` wrapper with the mark. It used to be, and
           \`w-full\` then resolved against that wrapper rather than
           against the header — measured at **193px** on a 390px
           viewport, because the account controls beside it are
           \`shrink-0\`. Two links already did not fit that; the third
           made it visible, wrapping the header to four rows. This is
           exactly customer-app's own header shape, and for the same
           reason. -->
      <nav
        class="order-last flex w-full flex-wrap items-center gap-2 sm:order-none sm:w-auto sm:flex-1"
      >
        @for (link of visibleNavLinks(); track link.path) {
          <a
            [routerLink]="link.path"
            [routerLinkActive]="navLinkActiveClass"
            #active="routerLinkActive"
            [attr.aria-current]="active.isActive ? 'page' : null"
            [class]="navLinkClass"
          >
            {{ link.label }}
          </a>
        }
      </nav>
      <div class="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
        <span class="hidden truncate text-sm text-muted sm:inline">{{
          authStore.user()?.email
        }}</span>
        <!-- No resolveRoute passed, deliberately: this app signs in via
             the client-admin JWT audience, so a validator-app user
             could legitimately receive a Driver/Vehicle
             compliance-expiry notification if they hold a Role at that
             Client — but this app has no Driver/Vehicle screens at
             all. Every notification here is mark-read-only, per
             docs/specs/9-notifications.md's Slice B plan. -->
        <app-notification-bell />
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
  // `whitespace-nowrap`: at 390px the consumer profile's larger type
  // broke "Record tap" across two lines inside its own pill.
  protected readonly navLinkClass =
    'inline-flex min-h-11 items-center rounded-md px-3 text-sm whitespace-nowrap text-default hover:bg-surface-muted hover:text-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

  protected readonly navLinkActiveClass = 'bg-primary-subtle text-strong font-medium';

  private readonly navLinks: readonly { path: string; label: string; permission?: string }[] = [
    { path: '/record', label: 'Record tap' },
    { path: '/validate-ticket', label: 'Validate ticket' },
    { path: '/report-issue', label: 'Report fault', permission: 'incidents.manage' },
  ];

  /**
   * The two original links stay unconditional for the reason this
   * component's own docstring gives — `tapngo.record` and
   * `ticketing.validate` are always granted together, so anyone who can
   * reach one screen can reach the other.
   *
   * **That argument does not extend to `incidents.manage`.** It is a
   * separate codename that a custom Role can perfectly well omit while
   * still granting the two tapping ones, so this link is filtered
   * rather than rendered and then 403'd by its own guard.
   */
  protected readonly visibleNavLinks = computed(() =>
    this.navLinks.filter(
      (link) => !link.permission || this.permissions.hasAny([link.permission])
    )
  );

  protected readonly authStore = inject(AuthStore);
  private readonly permissions = inject(PermissionsService);
  private readonly authApi = inject(AuthApiService);
  private readonly router = inject(Router);

  protected async signOut(): Promise<void> {
    this.authApi.logout();
    await this.router.navigate(['/login']);
  }
}
