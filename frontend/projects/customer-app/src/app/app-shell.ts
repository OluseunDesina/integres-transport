import { BreakpointObserver } from '@angular/cdk/layout';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthApiService } from '@auth';
import { BrandMark, NotificationBell, type NotificationRouteResolver } from '@layout';
import { Icon, Toggle, type IconName } from '@shared-ui';
import { map } from 'rxjs';

import { SeniorModeStore } from './shared/data/store/senior-mode.store';

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

// `min-w-0`: without it, a flex item's default `min-width: auto` keeps
// it no narrower than its own unbreakable content — and these seven
// items don't wrap the same amount ("Tap & Go" breaks after "Tap";
// "Payments" and "Journeys" are one word each and cannot). At 320px
// that left the two-word tab measured at 28px, well under the 44px
// touch-target minimum, while its single-word neighbours held their
// wider intrinsic size. `min-w-0` lets every tab actually take its
// equal flex share; `break-words` then lets a still-too-long word wrap
// mid-word inside that share rather than overflow it, matching the
// spec's own "wrap, never truncate" rule for narrow columns.
const TAB_LINK_CLASS =
  'flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 break-words px-1 py-1.5 text-center text-[11px] leading-none text-default hover:bg-surface-muted hover:text-strong focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';

const NAV_LINK_ACTIVE_CLASS = 'bg-primary-subtle text-strong font-medium';

/** Below this width the bar wraps mid-label rather than simply
 * shrinking — see the app-shell docstring — so it moves to a bottom
 * tab bar instead. Matches Tailwind's own `sm` breakpoint (640px) so
 * this query and every `sm:` class in the template agree on where the
 * layout actually changes. */
const MOBILE_BREAKPOINT = '(max-width: 639px)';

interface NavLink {
  path: string;
  label: string;
  icon: IconName;
}

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
 *
 * **Spec 21 slice 1.** Seven links on a single header row forced the
 * *page* to scroll horizontally below roughly 500px and, at the
 * authoritative 390px viewport, wrapped mid-label ("Tap & Go" onto
 * three lines, "Sign out" overlapping "Journeys") — recorded in
 * `docs/ui-review/10-booking-modes/iteration-1.md`, unowned since, and
 * this spec's to fix. Wrapping the row onto its own line (the previous
 * fix, still visible in git history) worked but only postponed the
 * problem to whatever count of links came next; this spec owns mobile
 * navigation outright, so the nav moves to a **fixed bottom tab bar**
 * below `sm` (640px) — the ordinary consumer-transit pattern, keeps
 * every target in thumb reach, and removes the overflow at its cause
 * instead of shrinking type until it fits. `sm` and above keeps the
 * original top-bar links.
 *
 * Only one `<nav aria-label="Primary">` renders at a time — an `@if`
 * on the same breakpoint signal that drives every other change here,
 * not two copies toggled by CSS visibility. A screen reader announces
 * a landmark once per render regardless of `display`/`hidden`, so a
 * pair of hidden-but-present navs is a duplicate landmark, not an
 * invisible one.
 *
 * **Spec 21 slice 3.** The Senior Mode toggle lives in the always-rendered
 * `ml-auto` cluster (bell, sign out) rather than inside the `@if
 * (!isMobile())` nav — the spec requires it reachable "at every
 * viewport", and that block disappears below `sm`. `ui-toggle` renders
 * no text of its own, so the visible "Senior mode" label beside it and
 * the `describedBy` hint are both this component's, not the control's —
 * same split business-form.html already uses for its own toggles.
 */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-screen flex-col bg-surface-muted' },
  imports: [RouterLink, RouterLinkActive, RouterOutlet, BrandMark, NotificationBell, Icon, Toggle],
  template: `
    <header class="border-b border-border bg-surface">
      <div
        class="mx-auto flex min-h-14 max-w-4xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2"
      >
        <a
          routerLink="/home"
          aria-label="Home"
          class="flex shrink-0 items-center rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <app-brand-mark />
        </a>

        @if (!isMobile()) {
          <nav
            aria-label="Primary"
            class="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-0.5"
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
        }

        <div class="ml-auto flex flex-wrap items-center justify-end gap-2">
          <div class="flex items-center gap-2">
            <span class="hidden text-sm font-medium text-default sm:inline">Senior mode</span>
            <span id="senior-mode-hint" class="sr-only">
              Larger text, higher contrast and a simplified layout throughout the app.
            </span>
            <ui-toggle
              label="Senior mode"
              describedBy="senior-mode-hint"
              [checked]="seniorMode.enabled()"
              (toggled)="seniorMode.set($event)"
            />
          </div>
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

    <!-- overflow-x-hidden: a defensive backstop, not a fix for one
         component. ui-table's own overflow-x-auto wrapper already
         contains a too-wide table internally (verified — its own box
         stays within the viewport), but a table element wider than that
         wrapper still inflated document.documentElement.scrollWidth in
         real Chromium once Senior Mode (spec 21 slice 3) grew a row past
         390/768px for the first time — a table/scroll-container
         interaction, not a layout bug reachable by fixing one ancestor's
         min-width. This is the one place in the shell all page content
         funnels through, so it is where "no horizontal page overflow"
         is actually guaranteed rather than hoped for. -->
    <main
      class="mx-auto w-full max-w-4xl flex-1 overflow-x-hidden px-4 py-8"
      [class.pb-24]="isMobile()"
    >
      <router-outlet />
    </main>

    @if (isMobile()) {
      <!-- pb-[env(...)] on the bar itself, not on main: the safe-area
           inset is chrome the bar must clear on notched devices, and
           main's own bottom padding above is sized to clear the bar,
           not the device inset underneath it. -->
      <nav
        aria-label="Primary"
        class="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
      >
        <div class="mx-auto flex max-w-4xl">
          @for (link of navLinks; track link.path) {
            <a
              [routerLink]="link.path"
              [routerLinkActive]="navLinkActiveClass"
              #active="routerLinkActive"
              [attr.aria-current]="active.isActive ? 'page' : null"
              [class]="tabLinkClass"
            >
              <ui-icon [name]="link.icon" [size]="20" />
              {{ link.label }}
            </a>
          }
        </div>
      </nav>
    }
  `,
})
export class AppShell {
  protected readonly resolveNotificationRoute = resolveNotificationRoute;
  protected readonly navLinkClass = NAV_LINK_CLASS;
  protected readonly tabLinkClass = TAB_LINK_CLASS;
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
  // an action. "Activity" (spec 20 slice 4) is a home quick-link, not a
  // nav destination, for the same reason this bar was already at
  // capacity before spec 21 arrived.
  //
  // The labels are shorter than the screens they open, and that is
  // deliberate. "My " says nothing in an app where every screen is the
  // signed-in passenger's own, and "trips" is what the whole app is
  // about — with those three words gone the set fits the top bar at
  // 1200px and, matched with an icon apiece, the bottom tab bar below
  // 640px. Icons reuse client-admin-app's own semantics for the same
  // concept (`document-check` for bookings, `banknotes` for payments,
  // `credit-card` for wallet) rather than choosing a second meaning for
  // the same glyph.
  protected readonly navLinks: readonly NavLink[] = [
    { path: '/search', label: 'Search', icon: 'magnifying-glass' },
    { path: '/my-bookings', label: 'Bookings', icon: 'document-check' },
    { path: '/credentials', label: 'Tap & Go', icon: 'bolt' },
    { path: '/journeys', label: 'Journeys', icon: 'clock' },
    { path: '/payments', label: 'Payments', icon: 'banknotes' },
    { path: '/wallet', label: 'Wallet', icon: 'credit-card' },
    { path: '/my-reports', label: 'Reports', icon: 'exclamation-triangle' },
  ];

  private readonly authApi = inject(AuthApiService);
  private readonly router = inject(Router);
  protected readonly seniorMode = inject(SeniorModeStore);

  protected readonly isMobile = toSignal(
    inject(BreakpointObserver)
      .observe(MOBILE_BREAKPOINT)
      .pipe(map((result) => result.matches)),
    { initialValue: false }
  );

  protected async signOut(): Promise<void> {
    this.authApi.logout();
    await this.router.navigate(['/login']);
  }
}
