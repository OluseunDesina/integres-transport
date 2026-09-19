import { BreakpointObserver } from '@angular/cdk/layout';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthApiService, AuthStore, PermissionsService } from '@auth';
import { ActionMenu, Icon, type ActionMenuItem, type IconName } from '@shared-ui';
import { map } from 'rxjs';

import { NavCollapseStore } from './nav-collapse-store';
import { NotificationBell, type NotificationRouteResolver } from './notification-bell';

export interface NavItem {
  label: string;
  path: string;
  icon: IconName;
  permissions: readonly string[];
  /**
   * Optional section label rendered above the first item carrying it —
   * consecutive items sharing the same value are one visual group, with
   * no other behavior change (still one flat permission-filtered list
   * underneath). Omit it and an item renders exactly as before; a caller
   * with a short nav (`customer-app`, `validator-app`) has no reason to
   * set it. Purely a display grouping, not a collapsible one — see
   * `navRows`.
   */
  group?: string;
}

type NavRow =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'item'; key: string; item: NavItem };

/** A row in the profile menu's business switcher — caller-supplied
 * (client-admin-app-only concept; @layout stays app-agnostic, same
 * shape as navItems already being caller-supplied per-app data). */
export interface BusinessSwitcherItem {
  id: string;
  name: string;
}

/**
 * An entry in the top bar's "New…" menu — spec 14 slice 3a.
 *
 * Caller-supplied for the same reason `navItems` is: `@layout` stays
 * app-agnostic, and only the app knows which records it can create. An
 * app that passes none (super-admin, validator) renders no top bar at
 * all, so nothing shifts for them.
 */
export interface QuickAction {
  label: string;
  /** `routerLink` path, navigated on select. */
  path: string;
  permissions: readonly string[];
}

/** Sidebar collapses to an icon-only rail below this width, overriding
 * whatever the user last manually chose (NavCollapseStore) until the
 * viewport widens back past it — see effectiveCollapsed below. */
const COLLAPSE_BREAKPOINT = '(max-width: 768px)';

/**
 * Below this width the 64px icon rail itself is too much: self-check
 * 2026-09-12-specs19-21's F9 measured it at ~12% of a 390px viewport,
 * and it eats directly into the width budget `ui-table`'s own
 * three-times-hardened 390px fit depends on. Strictly narrower than
 * COLLAPSE_BREAKPOINT, so the two never overlap: 640–768px still gets
 * today's icon rail, and only below 640px does the sidebar go fully
 * off-canvas instead. 640px matches `customer-app`'s own `AppShell`
 * mobile breakpoint literal, for the same phones that pattern targets
 * — though the pattern itself does not transfer (see the class
 * docstring's own note on why a bottom tab bar doesn't fit this
 * console's permission-filtered nav, business switcher and profile
 * menu).
 */
const DRAWER_BREAKPOINT = '(max-width: 639px)';

/**
 * First `layout` component with real service dependencies (`AuthStore`,
 * `PermissionsService`, `AuthApiService` from `@auth`) — see
 * docs/specs/2-client-admin-super-admin-ui.md §4. Nav-item visibility
 * reads from the same `PermissionsService.hasAny()` source `permissionGuard`
 * and `*appHasPermission` already use, not a fourth divergent check. This
 * is a layout wrapper, not an access gate — the parent route it's used on
 * carries no guard of its own; each child route keeps its own
 * `canActivate: [permissionGuard]`.
 *
 * Left sidebar, not a top bar (redesigned from the original Phase 2
 * shape) — collapsible to an icon-only rail, either by the user's own
 * toggle (persisted via NavCollapseStore) or automatically below
 * COLLAPSE_BREAKPOINT (first use of CDK's BreakpointObserver in this
 * repo). No cdkTrapFocus here — this is persistent page chrome, not a
 * modal/overlay, matching AuthLayout's own documented reasoning for why
 * a focus trap doesn't belong on a bare page.
 *
 * Below DRAWER_BREAKPOINT the sidebar goes further: fully off-canvas
 * (not just icon-only), toggled by a hamburger button in a slim top bar
 * that only exists at that width. This is a drawer, not the same
 * pattern as `customer-app`'s `AppShell` bottom tab bar — a fixed-count
 * tab bar has no analogue for a permission-filtered nav list, a
 * business switcher and a profile menu, all of which this sidebar
 * carries. `effectiveCollapsed` is what makes the drawer reuse every
 * existing icon-rail-vs-expanded template branch below rather than
 * needing a second set of them: opening the drawer is treated as
 * "temporarily not collapsed" for exactly as long as it stays open. The
 * closed drawer is `inert`, not just visually off-canvas — otherwise
 * its nav links, profile button and notification bell would stay in
 * the keyboard tab order while invisible, the same class of bug fixed
 * in `ui-map`'s markers during spec 21 slice 1.
 *
 * The bottom profile block is a purpose-built dropdown/menu (not a
 * generic `ui-menu` primitive — one specific-shaped menu, one consumer,
 * no second use case anywhere in these apps today) showing the signed-in
 * user's email/role/Client name, an optional business switcher, and
 * Sign out (moved here from its own always-visible button). The
 * `businesses`/`activeBusinessId`/`businessSelected` I/O let the
 * switcher live here without `@layout` depending on a
 * client-admin-app-only "Business" concept — the caller supplies it,
 * same as `navItems`. The switcher section only renders when
 * `businesses` is non-empty AND `authStore.user()?.isClientStaff` is
 * true — platform staff (every super-admin-app session) are always
 * client-less by construction, so that flag alone is a sufficient,
 * non-prop-drilled gate; `super-admin-app`'s `AppShell` simply never
 * binds the three business I/O.
 */
@Component({
  selector: 'app-nav-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // `h-screen`, not `min-h-screen` (a deliberate departure from every
    // other shell in this codebase — see the class docstring): a flex
    // container needs a *definite* height, not just a minimum, for
    // `align-items: stretch` to give a shrinkable cross-size to stretch
    // against. Without it, `<main>`'s own `min-h-0` has nothing to
    // shrink relative to and this host just grows to fit content
    // regardless — confirmed live, not assumed, when the quick-actions
    // bar's sticky div stayed inert under this fix's first attempt.
    class: 'flex h-screen bg-surface-muted',
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'onDocumentEscape()',
  },
  imports: [ActionMenu, RouterLink, RouterLinkActive, RouterOutlet, Icon, NotificationBell],
  template: `
    @if (isNarrowestViewport() && mobileMenuOpen()) {
      <!-- A real \`button\`, not a clickable \`div\` — native button
           semantics satisfy the interactive-element lint rules for free
           (focusable, keyboard-activatable) without a second Escape/
           click handler for keyboard users, who already close the
           drawer via the document-level Escape listener. -->
      <button
        type="button"
        class="fixed inset-0 z-10 cursor-default bg-black/40"
        aria-label="Close navigation menu"
        (click)="closeDrawer(false)"
      ></button>
    }

    <!-- \`h-screen\`, always: bounds this column to the viewport instead
         of stretching to match \`<main>\`'s content height (the host stays
         \`min-h-screen\`, unchanged, matching every other shell in this
         codebase — only this component needs a fixed-height sidebar).
         \`sticky top-0\` (desktop/tablet only — the drawer's own \`fixed\`
         already pins it at every width below DRAWER_BREAKPOINT) keeps it
         pinned while the page's own document scroll handles \`<main>\`'s
         overflow, the standard pinned-sidebar pattern. Neither alone
         fixes the nav list itself scrolling internally — see \`<nav>\`'s
         own \`min-h-0\` below for that half. -->
    <aside
      class="flex h-screen shrink-0 flex-col border-r border-border bg-surface transition-[width,transform] duration-150 motion-reduce:transition-none"
      [class.w-64]="!effectiveCollapsed()"
      [class.w-16]="effectiveCollapsed()"
      [class.sticky]="!isNarrowestViewport()"
      [class.top-0]="!isNarrowestViewport()"
      [class.fixed]="isNarrowestViewport()"
      [class.inset-y-0]="isNarrowestViewport()"
      [class.left-0]="isNarrowestViewport()"
      [class.z-20]="isNarrowestViewport()"
      [class.-translate-x-full]="isNarrowestViewport() && !mobileMenuOpen()"
      [attr.inert]="isNarrowestViewport() && !mobileMenuOpen() ? '' : null"
    >
      <div class="flex h-14 items-center justify-between gap-2 border-b border-border px-3">
        @if (!effectiveCollapsed()) {
          <span class="truncate text-sm font-semibold text-strong">{{ appName() }}</span>
        } @else {
          <span class="sr-only">{{ appName() }}</span>
        }
        @if (!isNarrowestViewport()) {
          <app-notification-bell align="left" [resolveRoute]="resolveNotificationRoute()" />
        }
      </div>

      <!-- \`min-h-0\`: a flex item's default \`min-height: auto\` refuses to
           shrink below its own content's height, which silently defeats
           \`overflow-y-auto\` above — a classic flexbox gotcha, not a typo.
           Without this, a nav list taller than \`<aside>\` just grows the
           aside instead of scrolling internally. -->
      <nav
        role="navigation"
        [attr.aria-label]="appName() + ' primary'"
        class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2"
      >
        @for (row of navRows(); track row.key) {
          @if (row.kind === 'header') {
            @if (!effectiveCollapsed()) {
              <p class="mt-2 truncate px-3 pt-1 pb-1 text-xs font-medium tracking-wide text-muted uppercase first:mt-0">
                {{ row.label }}
              </p>
            }
          } @else {
            <a
              [routerLink]="row.item.path"
              routerLinkActive="bg-primary-subtle text-strong font-medium"
              #rla="routerLinkActive"
              [attr.aria-current]="rla.isActive ? 'page' : null"
              [attr.aria-label]="effectiveCollapsed() ? row.item.label : null"
              [title]="effectiveCollapsed() ? row.item.label : null"
              (click)="closeDrawer(false)"
              class="inline-flex min-h-11 min-w-11 items-center gap-3 rounded-md px-3 text-sm text-default hover:bg-surface-muted hover:text-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <ui-icon [name]="row.item.icon" />
              @if (!effectiveCollapsed()) {
                <span class="truncate">{{ row.item.label }}</span>
              }
            </a>
          }
        }
      </nav>

      <div class="border-t border-border p-2">
        <button
          type="button"
          (click)="collapseStore.toggle()"
          [attr.aria-expanded]="!effectiveCollapsed()"
          aria-label="Toggle navigation width"
          class="inline-flex min-h-11 w-full min-w-11 items-center justify-center gap-2 rounded-md text-sm text-muted hover:bg-surface-muted hover:text-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <ui-icon [name]="effectiveCollapsed() ? 'chevron-double-right' : 'chevron-double-left'" />
          @if (!effectiveCollapsed()) {
            <span>Collapse</span>
          }
        </button>
      </div>

      <div class="relative border-t border-border p-2" #profileRoot>
        <button
          type="button"
          #profileTrigger
          (click)="toggleMenu()"
          aria-haspopup="menu"
          [attr.aria-expanded]="menuOpen()"
          [attr.aria-label]="effectiveCollapsed() ? (authStore.user()?.email ?? 'Account menu') : null"
          [title]="effectiveCollapsed() ? (authStore.user()?.email ?? '') : null"
          class="inline-flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-left hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          [class.justify-center]="effectiveCollapsed()"
        >
          <span
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-xs font-semibold text-default"
          >
            {{ initial() }}
          </span>
          @if (!effectiveCollapsed()) {
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium text-strong">{{
                authStore.user()?.email
              }}</span>
              @if (roleAndClientLabel(); as label) {
                <span class="block truncate text-xs text-muted">{{ label }}</span>
              }
            </span>
            <ui-icon name="chevron-up-down" [size]="16" class="shrink-0 text-muted" />
          }
        </button>

        @if (menuOpen()) {
          <div
            role="menu"
            aria-label="Account menu"
            tabindex="-1"
            class="absolute bottom-full left-2 z-10 mb-1 flex max-h-[70vh] w-72 flex-col rounded-md border border-border bg-surface p-2 shadow-md"
          >
            <div class="shrink-0 border-b border-border px-2 pb-2">
              <p class="truncate text-sm font-medium text-strong">{{ authStore.user()?.email }}</p>
              @if (roleAndClientLabel(); as label) {
                <p class="truncate text-xs text-muted">{{ label }}</p>
              }
            </div>

            @if (showBusinessSwitcher()) {
              <div class="min-h-0 overflow-y-auto border-b border-border py-2">
                <p class="px-2 pb-1 text-xs font-medium tracking-wide text-muted uppercase">
                  Business
                </p>
                @for (business of businesses(); track business.id) {
                  <button
                    type="button"
                    role="menuitemradio"
                    [attr.aria-checked]="business.id === activeBusinessId()"
                    (click)="selectBusiness(business.id)"
                    class="flex min-h-11 w-full items-center justify-between rounded-md px-2 text-sm text-default hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    [class.bg-primary-subtle]="business.id === activeBusinessId()"
                  >
                    <span class="truncate">{{ business.name }}</span>
                    @if (business.id === activeBusinessId()) {
                      <ui-icon name="check" [size]="16" />
                    }
                  </button>
                }
              </div>
            }

            <div class="pt-2">
              <button
                type="button"
                role="menuitem"
                (click)="signOut()"
                class="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-sm font-medium text-default hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <ui-icon name="arrow-right-start-on-rectangle" [size]="20" />
                <span>Sign out</span>
              </button>
            </div>
          </div>
        }
      </div>
    </aside>

    <!-- \`min-h-0\`, same flexbox reason as \`<nav>\`'s own comment above:
         without it this flex child refuses to shrink below its content's
         height, \`overflow-y-auto\` never engages, and the quick-actions
         bar's already-\`sticky\` div below has no real scrolling ancestor
         to stick against — it just scrolls away with the document. With
         it, \`<main>\` becomes the actual bounded/scrolling pane (the
         document itself no longer scrolls), and that \`sticky\` finally
         does what it was written to do. -->
    <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      @if (isNarrowestViewport()) {
        <!-- Lives in \`main\`'s own flex-column, not as a sibling of
             \`aside\`/\`main\` at the host's flex-row level — a sibling
             there would sit *beside* them, not stacked above. -->
        <header
          class="sticky top-0 z-10 flex h-14 w-full shrink-0 items-center gap-2 border-b border-border bg-surface px-3"
        >
          <button
            type="button"
            #drawerTrigger
            (click)="openDrawer()"
            aria-haspopup="true"
            [attr.aria-expanded]="mobileMenuOpen()"
            aria-label="Open navigation menu"
            class="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted hover:bg-surface-muted hover:text-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <ui-icon name="bars-3" />
          </button>
          <span class="truncate text-sm font-semibold text-strong">{{ appName() }}</span>
          <app-notification-bell
            align="left"
            [resolveRoute]="resolveNotificationRoute()"
            class="ml-auto"
          />
        </header>
      }
      @if (visibleQuickActions().length > 0) {
        <!-- Rendered only when the app supplies actions, so an app
             without them keeps exactly its previous layout. \`top-14\`
             instead of \`top-0\` when the mobile header above is also
             present — both are \`sticky\`, and without the offset this
             bar would paint over the header at the same scroll-pinned
             position rather than stacking beneath it. -->
        <div
          class="sticky z-10 flex justify-end border-b border-border bg-surface px-6 py-2"
          [class.top-0]="!isNarrowestViewport()"
          [class.top-14]="isNarrowestViewport()"
        >
          <ui-action-menu
            label="Create a new record"
            triggerLabel="New"
            [items]="quickActionItems()"
            (selected)="onQuickAction($event)"
          />
        </div>
      }
      <div class="mx-auto w-full max-w-6xl p-6">
        <router-outlet />
      </div>
    </main>
  `,
})
export class NavShell {
  readonly appName = input.required<string>();
  readonly navItems = input<readonly NavItem[]>([]);
  readonly businesses = input<readonly BusinessSwitcherItem[]>([]);
  readonly activeBusinessId = input<string | null>(null);
  readonly businessSelected = output<string>();
  // Passed straight through to NotificationBell — NavShell has no
  // content-projection slot, so it renders the bell itself in its own
  // header rather than each caller (client-admin-app/super-admin-app)
  // duplicating that placement. Defaults to NotificationBell's own
  // "mark read, never navigate" behavior when a caller doesn't pass one.
  readonly resolveNotificationRoute = input<NotificationRouteResolver>(() => null);
  /**
   * Records the app can create from anywhere. Empty by default, which
   * renders no top bar — `super-admin-app` and `validator-app` are
   * unaffected by this addition.
   *
   * Solves a real irritation: creating any record meant navigating to
   * its own list screen first, because the only "New …" button lives in
   * that screen's page header.
   */
  readonly quickActions = input<readonly QuickAction[]>([]);

  protected readonly authStore = inject(AuthStore);
  protected readonly collapseStore = inject(NavCollapseStore);
  private readonly authApi = inject(AuthApiService);
  private readonly permissionsService = inject(PermissionsService);
  private readonly router = inject(Router);

  private readonly breakpointObserver = inject(BreakpointObserver);

  private readonly isNarrowViewport = toSignal(
    this.breakpointObserver.observe(COLLAPSE_BREAKPOINT).pipe(map((result) => result.matches)),
    { initialValue: false }
  );

  protected readonly isNarrowestViewport = toSignal(
    this.breakpointObserver.observe(DRAWER_BREAKPOINT).pipe(map((result) => result.matches)),
    { initialValue: false }
  );

  protected readonly mobileMenuOpen = signal(false);

  // Opening the drawer is "temporarily not collapsed" — every existing
  // icon-rail-vs-expanded branch below (nav labels, the profile block,
  // the width itself) already keys off this one signal, so the drawer
  // needs no second set of them.
  protected readonly effectiveCollapsed = computed(
    () =>
      (this.isNarrowViewport() || this.collapseStore.collapsed()) &&
      !(this.isNarrowestViewport() && this.mobileMenuOpen())
  );

  protected readonly visibleNavItems = computed(() =>
    this.navItems().filter(
      (item) => item.permissions.length === 0 || this.permissionsService.hasAny(item.permissions)
    )
  );

  /**
   * Flattens `visibleNavItems` into a render-ready row list, inserting a
   * `'header'` row wherever `item.group` changes from the previous item
   * — one row per distinct group run, not per group overall, since two
   * separated runs of the same group name (unusual, but not prevented)
   * should still get two headers rather than silently merging. An
   * ungrouped item (`group` undefined) never gets a header, so a caller
   * that sets no `group` at all (`customer-app`, `super-admin-app`,
   * `validator-app`) renders exactly the flat list it always has.
   */
  protected readonly navRows = computed<NavRow[]>(() => {
    const rows: NavRow[] = [];
    let currentGroup: string | undefined;
    for (const item of this.visibleNavItems()) {
      if (item.group !== currentGroup) {
        currentGroup = item.group;
        if (currentGroup) {
          rows.push({ kind: 'header', key: `group:${currentGroup}:${item.path}`, label: currentGroup });
        }
      }
      rows.push({ kind: 'item', key: item.path, item });
    }
    return rows;
  });

  /** Permission-gated the same way `visibleNavItems` is — a create
   * action a user cannot perform must not be offered. */
  protected readonly visibleQuickActions = computed(() =>
    this.quickActions().filter(
      (action) =>
        action.permissions.length === 0 || this.permissionsService.hasAny(action.permissions)
    )
  );

  /** `ui-action-menu` takes ids, so the path is the id — it is already
   * unique per action and is exactly what the handler needs. */
  protected readonly quickActionItems = computed<ActionMenuItem[]>(() =>
    this.visibleQuickActions().map((action) => ({ id: action.path, label: action.label }))
  );

  protected onQuickAction(path: string): void {
    void this.router.navigate([path]);
  }

  protected readonly menuOpen = signal(false);
  private readonly profileRoot = viewChild.required<ElementRef<HTMLElement>>('profileRoot');
  private readonly profileTrigger = viewChild.required<ElementRef<HTMLButtonElement>>('profileTrigger');
  // `.required` doesn't fit here — the trigger only exists in the DOM
  // at all when `isNarrowestViewport()` is true, unlike `profileTrigger`
  // above, which is unconditionally rendered.
  private readonly drawerTrigger = viewChild<ElementRef<HTMLButtonElement>>('drawerTrigger');

  protected readonly initial = computed(() => (this.authStore.user()?.email ?? '?').charAt(0).toUpperCase());
  protected readonly roleAndClientLabel = computed(() => {
    const user = this.authStore.user();
    if (!user) {
      return '';
    }
    return [user.roleName, user.clientName].filter(Boolean).join(' · ');
  });

  // isClientStaff is unconditionally false for every super-admin-app
  // session (platform staff have no client by construction — see class
  // docstring), so this single flag is a sufficient gate without
  // NavShell needing to know which app it's running inside.
  protected readonly showBusinessSwitcher = computed(
    () => this.authStore.user()?.isClientStaff === true && this.businesses().length > 0
  );

  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  protected closeMenu(restoreFocus: boolean): void {
    this.menuOpen.set(false);
    if (restoreFocus) {
      this.profileTrigger().nativeElement.focus();
    }
  }

  protected openDrawer(): void {
    this.mobileMenuOpen.set(true);
  }

  protected closeDrawer(restoreFocus: boolean): void {
    this.mobileMenuOpen.set(false);
    if (restoreFocus) {
      this.drawerTrigger()?.nativeElement.focus();
    }
  }

  protected onDocumentClick(event: MouseEvent): void {
    if (!this.menuOpen()) {
      return;
    }
    const root = this.profileRoot().nativeElement;
    if (!root.contains(event.target as Node)) {
      this.closeMenu(false);
    }
  }

  // A template (keydown.escape) binding on the panel itself only fires
  // when the panel (or a descendant) already has focus — but opening
  // the menu doesn't move focus off the trigger button, so Escape would
  // never reach it. A document-level listener, matching the
  // click-outside pattern above, is what actually catches it regardless
  // of which element inside (or outside) the menu currently has focus.
  protected onDocumentEscape(): void {
    if (this.menuOpen()) {
      this.closeMenu(true);
    }
    if (this.mobileMenuOpen()) {
      this.closeDrawer(true);
    }
  }

  protected selectBusiness(id: string): void {
    this.businessSelected.emit(id);
    this.closeMenu(true);
  }

  protected async signOut(): Promise<void> {
    this.authApi.logout();
    await this.router.navigate(['/login']);
  }
}
