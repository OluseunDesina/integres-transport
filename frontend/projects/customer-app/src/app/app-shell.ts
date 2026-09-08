import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthApiService } from '@auth';
import { BrandMark, NotificationBell, type NotificationRouteResolver } from '@layout';

// docs/specs/9-notifications.md: this app's own recipient type is
// ticket_unused_reminder (related_object_type "Ticket"). There is no
// route reachable from a Ticket's own id alone — the only
// ticket-viewing screen, my-bookings/:id/tickets, is keyed by Booking
// id, which Notification doesn't carry (confirmed before this slice
// was built) — so this resolves to the general bookings list, not a
// deep link to the specific ticket.
const resolveNotificationRoute: NotificationRouteResolver = (type) => {
  switch (type) {
    case 'Ticket':
      return ['/my-bookings'];
    default:
      return null;
  }
};

const NAV_LINK_CLASS =
  'inline-flex min-h-11 items-center rounded-md px-3 text-sm text-default hover:bg-surface-muted hover:text-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

const NAV_LINK_ACTIVE_CLASS = 'bg-primary-subtle text-strong font-medium';

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
  host: { class: 'flex min-h-screen flex-col bg-surface-muted' },
  imports: [RouterLink, RouterLinkActive, RouterOutlet, BrandMark, NotificationBell],
  template: `
    <header class="border-b border-border bg-surface">
      <!-- Two rows below \`md\`, one from \`md\` up. Six nav links, a
           wordmark, a bell and Sign out on a single fixed-height row
           forced the *page* to scroll horizontally at 390px and
           overlapped each other doing it — recorded in
           docs/ui-review/10-booking-modes/iteration-1.md and unowned
           since. Letting the row simply wrap fixed the overflow and
           looked broken: the nav collapsed into a tall column beside
           the wordmark. So the nav takes its own full-width row instead
           (\`order-last w-full\`), with the wordmark and the account
           controls sharing the row above it.

           A passenger bottom tab bar is spec 21's, which owns mobile
           navigation and will replace this header wholesale. This is
           the overflow bug fixed, not that design pre-empted. -->
      <div
        class="mx-auto flex min-h-14 max-w-4xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 md:flex-nowrap md:py-0"
      >
        <a
          routerLink="/home"
          aria-label="Home"
          class="flex shrink-0 items-center rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <app-brand-mark />
        </a>

        <nav
          aria-label="Primary"
          class="order-last flex w-full min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 md:order-none md:w-auto md:flex-1"
        >
          @for (link of navLinks; track link.path) {
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

        <div class="ml-auto flex shrink-0 items-center gap-1 md:ml-0">
          <app-notification-bell [resolveRoute]="resolveNotificationRoute" />
          <button
            type="button"
            (click)="signOut()"
            class="inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-sm font-medium text-default hover:bg-surface-muted hover:text-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>

    <main class="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
      <router-outlet />
    </main>
  `,
})
export class AppShell {
  protected readonly resolveNotificationRoute = resolveNotificationRoute;
  protected readonly navLinkClass = NAV_LINK_CLASS;
  protected readonly navLinkActiveClass = NAV_LINK_ACTIVE_CLASS;

  // Six links written out six times was 60 lines of identical markup in
  // which only two strings differed — and the `routerLinkActive`
  // template-reference name had to be unique per link, which is exactly
  // the kind of detail that gets copy-pasted wrong. `@for` gives each
  // iteration its own `#active` scope.
  //
  // Seven now, as of spec 17 slice 3. Only the *history* screen is in
  // the bar; "Report an issue" is a button on it and a row action in
  // my-bookings, because the destination is the record and reporting is
  // an action.
  // The labels are shorter than the screens they open, and that is
  // deliberate. Measured at 1200px, the authoritative desktop viewport:
  // the six original links came to 556px inside a 587px nav, and a
  // seventh took it to 656px and wrapped the bar onto a second row —
  // at a width with room to spare, which looked simply broken.
  //
  // "My " says nothing in an app where every screen is the signed-in
  // passenger's own, and "trips" is what the whole app is about. With
  // those three words gone the set is ~540px and fits on one row again.
  // The page headings keep "My bookings" and "My reports"; a nav label
  // is allowed to be terser than the screen it opens.
  //
  // This is the 390px collapse CLAUDE.md already records showing up at
  // a width where there was room, not a new bug — but this slice's link
  // is what surfaced it, so it is this slice's to keep in bounds. The
  // bar still wraps at 768px, which it did before this slice too; spec
  // 21 owns replacing this nav wholesale.
  protected readonly navLinks = [
    { path: '/search', label: 'Search' },
    { path: '/my-bookings', label: 'Bookings' },
    { path: '/credentials', label: 'Tap & Go' },
    { path: '/journeys', label: 'Journeys' },
    { path: '/payments', label: 'Payments' },
    { path: '/wallet', label: 'Wallet' },
    { path: '/my-reports', label: 'Reports' },
  ];

  private readonly authApi = inject(AuthApiService);
  private readonly router = inject(Router);

  protected async signOut(): Promise<void> {
    this.authApi.logout();
    await this.router.navigate(['/login']);
  }
}
