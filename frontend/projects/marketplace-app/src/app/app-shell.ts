import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthApiService, AuthStore } from '@auth';
import { NotificationBell, type NotificationRouteResolver } from '@layout';
import { filter, map } from 'rxjs';

import { MarketplaceLogo } from './shared/marketplace-logo';

// Same resolver `customer-app`'s own app-shell uses: the only
// ticket-viewing screen is keyed by Booking id, which Notification
// doesn't carry, so this resolves to the bookings list rather than a
// deep link to one ticket.
const resolveNotificationRoute: NotificationRouteResolver = (type) => {
  switch (type) {
    case 'Ticket':
      return ['/my-bookings'];
    default:
      return null;
  }
};

const FOCUS_ON_NAVY =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mk-accent';
const NAV_LINK_CLASS = `inline-flex min-h-11 items-center rounded-full px-3 sm:px-4 text-sm font-medium text-mk-on-navy-muted hover:bg-mk-navy-800 hover:text-white ${FOCUS_ON_NAVY}`;
const NAV_LINK_ACTIVE_CLASS = '!bg-mk-navy-800 !text-white';

/** Route data key a page sets to own its full width (a full-bleed hero,
 * a results page with a sidebar). Every other page gets the narrow
 * reading column the booking flow was built in. */
export const FULL_BLEED = 'fullBleed';

/**
 * Chrome for the marketplace — docs/specs/22-marketplace.md, restyled by
 * docs/specs/24-marketplace-redesign.md after wakanow.com: a navy top bar
 * that runs straight into the landing page's hero, and a full footer.
 *
 * Renders for signed-out visitors too (spec 22 slice 2 — search and
 * seat choice are public), so
 * the notification bell appears only once signed in, and a guest gets
 * "Log in" + "Create account" instead of "Sign out".
 */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-screen flex-col bg-surface-muted' },
  imports: [RouterLink, RouterLinkActive, RouterOutlet, MarketplaceLogo, NotificationBell],
  template: `
    <header class="bg-mk-navy-950 text-white">
      <div class="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:gap-x-6">
        <a routerLink="/search" aria-label="TransitOS home" [class]="'flex shrink-0 items-center rounded-lg ' + focusOnNavy">
          <app-marketplace-logo tone="light" />
        </a>

        <nav aria-label="Primary" class="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          @for (link of navLinks; track link.path) {
            <a
              [routerLink]="link.path"
              [routerLinkActive]="navLinkActiveClass"
              [routerLinkActiveOptions]="{ exact: link.exact }"
              #active="routerLinkActive"
              [attr.aria-current]="active.isActive ? 'page' : null"
              [class]="link.phone ? navLinkClass : navLinkClass + ' max-sm:hidden'"
            >
              {{ link.label }}
            </a>
          }
        </nav>

        <div class="ml-auto flex flex-wrap items-center justify-end gap-2">
          @if (isAuthenticated()) {
            <!-- The shared bell styles its trigger text-muted for a white
                 bar; on navy that is 3:1. Recoloured from here rather than
                 forking the component — the dropdown panel it opens is
                 white and keeps its own colours. -->
            <span
              class="contents [&_app-notification-bell>div>button]:text-white [&_app-notification-bell>div>button:hover]:bg-mk-navy-800"
            >
              <app-notification-bell [resolveRoute]="resolveNotificationRoute" />
            </span>
            <button type="button" (click)="signOut()" [class]="navLinkClass">Sign out</button>
          } @else {
            <a routerLink="/login" [class]="navLinkClass">Log in</a>
            <a
              routerLink="/register"
              [class]="'hidden min-h-11 items-center rounded-full bg-mk-accent px-5 sm:inline-flex text-sm font-semibold text-mk-navy-950 hover:bg-amber-300 ' + focusOnNavy"
            >
              Create account
            </a>
          }
        </div>
      </div>
    </header>

    <!-- One outlet, restyled — not two outlets behind an @if: swapping
         outlets mid-navigation re-activates the route into a destroyed
         context and the router throws. -->
    <main class="flex-1 overflow-x-hidden">
      <div [class]="fullBleed() ? 'w-full' : 'mx-auto w-full max-w-4xl px-4 py-8'">
        <router-outlet />
      </div>
    </main>

    <footer class="bg-mk-navy-950 text-mk-on-navy-muted">
      <div class="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div class="flex flex-col gap-3">
          <app-marketplace-logo tone="light" />
          <p class="text-sm leading-relaxed">
            Search and book road trips from every operator on TransitOS, in one place.
          </p>
        </div>
        <nav aria-labelledby="footer-travel" class="flex flex-col gap-2 text-sm">
          <h2 id="footer-travel" class="mb-1 text-xs font-semibold tracking-wider text-white uppercase">Travel</h2>
          <a routerLink="/search" [class]="footerLinkClass">Search trips</a>
          <a routerLink="/my-bookings" [class]="footerLinkClass">Manage a booking</a>
        </nav>
        <nav aria-labelledby="footer-account" class="flex flex-col gap-2 text-sm">
          <h2 id="footer-account" class="mb-1 text-xs font-semibold tracking-wider text-white uppercase">Account</h2>
          @if (isAuthenticated()) {
            <a routerLink="/my-bookings" [class]="footerLinkClass">My bookings</a>
          } @else {
            <a routerLink="/login" [class]="footerLinkClass">Log in</a>
            <a routerLink="/register" [class]="footerLinkClass">Create account</a>
          }
        </nav>
        <div class="flex flex-col gap-2 text-sm">
          <h2 class="mb-1 text-xs font-semibold tracking-wider text-white uppercase">Pay your way</h2>
          <p>Card, bank transfer or your TransitOS wallet, processed securely by Paystack.</p>
        </div>
      </div>
      <div class="border-t border-mk-navy-800">
        <p class="mx-auto max-w-6xl px-4 py-5 text-xs">© {{ year }} TransitOS. Every trip is run by its listed operator.</p>
      </div>
    </footer>
  `,
})
export class AppShell {
  protected readonly resolveNotificationRoute = resolveNotificationRoute;
  protected readonly navLinkClass = NAV_LINK_CLASS;
  protected readonly navLinkActiveClass = NAV_LINK_ACTIVE_CLASS;
  protected readonly focusOnNavy = FOCUS_ON_NAVY;
  protected readonly footerLinkClass = `w-fit rounded hover:text-white hover:underline ${FOCUS_ON_NAVY}`;
  protected readonly year = new Date().getFullYear();

  private readonly authApi = inject(AuthApiService);
  private readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);

  protected readonly isAuthenticated = this.authStore.isAuthenticated;

  protected readonly fullBleed = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.readFullBleed())
    ),
    { initialValue: this.readFullBleed() }
  );

  /** "My bookings" shows for guests too — Omio, FlixBus and Wakanow
   * all keep "manage booking" in the top bar for someone who booked on
   * another device. Its route guard sends a guest to sign in. */
  protected readonly navLinks = [
    // Hidden on phones: the logo already goes to search, and three
    // items plus "Log in" wrap the bar onto two lines at 390px.
    { path: '/search', label: 'Search trips', exact: false, phone: false },
    { path: '/my-bookings', label: 'My bookings', exact: false, phone: true },
  ];

  protected async signOut(): Promise<void> {
    this.authApi.logout();
    await this.router.navigate(['/login']);
  }

  /** Walks the router's *snapshot* tree, not the live `ActivatedRoute`
   * one: during the shell's own construction the live child routes are
   * not wired yet and reading them throws inside the router. */
  private readFullBleed(): boolean {
    let node = this.router.routerState.snapshot.root;
    while (node.firstChild) {
      node = node.firstChild;
    }
    return node.data[FULL_BLEED] === true;
  }
}
