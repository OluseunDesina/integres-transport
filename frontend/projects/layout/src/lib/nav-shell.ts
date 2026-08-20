import { BreakpointObserver } from '@angular/cdk/layout';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
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
import { Icon, type IconName } from '@shared-ui';
import { map } from 'rxjs';

import { NavCollapseStore } from './nav-collapse-store';
import { NotificationBell, type NotificationRouteResolver } from './notification-bell';

export interface NavItem {
  label: string;
  path: string;
  icon: IconName;
  permissions: readonly string[];
}

/** A row in the profile menu's business switcher — caller-supplied
 * (client-admin-app-only concept; @layout stays app-agnostic, same
 * shape as navItems already being caller-supplied per-app data). */
export interface BusinessSwitcherItem {
  id: string;
  name: string;
}

/** Sidebar collapses to an icon-only rail below this width, overriding
 * whatever the user last manually chose (NavCollapseStore) until the
 * viewport widens back past it — see effectiveCollapsed below. */
const COLLAPSE_BREAKPOINT = '(max-width: 768px)';

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
  host: { class: 'flex min-h-screen bg-slate-50' },
  imports: [RouterLink, RouterLinkActive, RouterOutlet, Icon, NotificationBell],
  template: `
    <aside
      class="flex shrink-0 flex-col border-r border-slate-200 bg-white transition-[width] duration-150 motion-reduce:transition-none"
      [class.w-64]="!effectiveCollapsed()"
      [class.w-16]="effectiveCollapsed()"
    >
      <div class="flex h-14 items-center justify-between gap-2 border-b border-slate-200 px-3">
        @if (!effectiveCollapsed()) {
          <span class="truncate text-sm font-semibold text-slate-900">{{ appName() }}</span>
        } @else {
          <span class="sr-only">{{ appName() }}</span>
        }
        <app-notification-bell align="left" [resolveRoute]="resolveNotificationRoute()" />
      </div>

      <nav
        role="navigation"
        [attr.aria-label]="appName() + ' primary'"
        class="flex flex-1 flex-col gap-1 overflow-y-auto p-2"
      >
        @for (item of visibleNavItems(); track item.path) {
          <a
            [routerLink]="item.path"
            routerLinkActive="bg-slate-100 text-slate-900 font-medium"
            #rla="routerLinkActive"
            [attr.aria-current]="rla.isActive ? 'page' : null"
            [attr.aria-label]="effectiveCollapsed() ? item.label : null"
            [title]="effectiveCollapsed() ? item.label : null"
            class="inline-flex min-h-11 min-w-11 items-center gap-3 rounded-md px-3 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900"
          >
            <ui-icon [name]="item.icon" />
            @if (!effectiveCollapsed()) {
              <span class="truncate">{{ item.label }}</span>
            }
          </a>
        }
      </nav>

      <div class="border-t border-slate-200 p-2">
        <button
          type="button"
          (click)="collapseStore.toggle()"
          [attr.aria-expanded]="!effectiveCollapsed()"
          aria-label="Toggle navigation width"
          class="inline-flex min-h-11 w-full min-w-11 items-center justify-center gap-2 rounded-md text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-900"
        >
          <ui-icon [name]="effectiveCollapsed() ? 'chevron-double-right' : 'chevron-double-left'" />
          @if (!effectiveCollapsed()) {
            <span>Collapse</span>
          }
        </button>
      </div>

      <div class="relative border-t border-slate-200 p-2" #profileRoot>
        <button
          type="button"
          #profileTrigger
          (click)="toggleMenu()"
          aria-haspopup="menu"
          [attr.aria-expanded]="menuOpen()"
          [attr.aria-label]="effectiveCollapsed() ? (authStore.user()?.email ?? 'Account menu') : null"
          [title]="effectiveCollapsed() ? (authStore.user()?.email ?? '') : null"
          class="inline-flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-left hover:bg-slate-50"
          [class.justify-center]="effectiveCollapsed()"
        >
          <span
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700"
          >
            {{ initial() }}
          </span>
          @if (!effectiveCollapsed()) {
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium text-slate-900">{{
                authStore.user()?.email
              }}</span>
              @if (roleAndClientLabel(); as label) {
                <span class="block truncate text-xs text-slate-500">{{ label }}</span>
              }
            </span>
            <ui-icon name="chevron-up-down" [size]="16" class="shrink-0 text-slate-400" />
          }
        </button>

        @if (menuOpen()) {
          <div
            role="menu"
            aria-label="Account menu"
            tabindex="-1"
            class="absolute bottom-full left-2 z-10 mb-1 flex max-h-[70vh] w-72 flex-col rounded-md border border-slate-200 bg-white p-2 shadow-lg"
          >
            <div class="shrink-0 border-b border-slate-100 px-2 pb-2">
              <p class="truncate text-sm font-medium text-slate-900">{{ authStore.user()?.email }}</p>
              @if (roleAndClientLabel(); as label) {
                <p class="truncate text-xs text-slate-500">{{ label }}</p>
              }
            </div>

            @if (showBusinessSwitcher()) {
              <div class="min-h-0 overflow-y-auto border-b border-slate-100 py-2">
                <p class="px-2 pb-1 text-xs font-medium tracking-wide text-slate-500 uppercase">
                  Business
                </p>
                @for (business of businesses(); track business.id) {
                  <button
                    type="button"
                    role="menuitemradio"
                    [attr.aria-checked]="business.id === activeBusinessId()"
                    (click)="selectBusiness(business.id)"
                    class="flex min-h-11 w-full items-center justify-between rounded-md px-2 text-sm text-slate-700 hover:bg-slate-50"
                    [class.bg-slate-100]="business.id === activeBusinessId()"
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
                class="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <ui-icon name="arrow-right-start-on-rectangle" [size]="20" />
                <span>Sign out</span>
              </button>
            </div>
          </div>
        }
      </div>
    </aside>

    <main class="min-w-0 flex-1 overflow-y-auto p-6">
      <div class="mx-auto max-w-6xl">
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

  protected readonly authStore = inject(AuthStore);
  protected readonly collapseStore = inject(NavCollapseStore);
  private readonly authApi = inject(AuthApiService);
  private readonly permissionsService = inject(PermissionsService);
  private readonly router = inject(Router);

  private readonly isNarrowViewport = toSignal(
    inject(BreakpointObserver)
      .observe(COLLAPSE_BREAKPOINT)
      .pipe(map((result) => result.matches)),
    { initialValue: false }
  );

  protected readonly effectiveCollapsed = computed(
    () => this.isNarrowViewport() || this.collapseStore.collapsed()
  );

  protected readonly visibleNavItems = computed(() =>
    this.navItems().filter(
      (item) => item.permissions.length === 0 || this.permissionsService.hasAny(item.permissions)
    )
  );

  protected readonly menuOpen = signal(false);
  private readonly profileRoot = viewChild.required<ElementRef<HTMLElement>>('profileRoot');
  private readonly profileTrigger = viewChild.required<ElementRef<HTMLButtonElement>>('profileTrigger');

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

  @HostListener('document:click', ['$event'])
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
  @HostListener('document:keydown.escape')
  protected onDocumentEscape(): void {
    if (this.menuOpen()) {
      this.closeMenu(true);
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
