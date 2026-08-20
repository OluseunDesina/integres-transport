import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnInit,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { Icon } from '@shared-ui';

type Notification = components['schemas']['Notification'];

/** Per-app customization point (docs/specs/9-notifications.md's
 * Frontend surface section): given a Notification's own
 * `related_object_type`/`related_object_id`, return Router commands to
 * navigate to on click, or `null` for "just mark it read, don't
 * navigate" — the default, and the correct behavior for any
 * type/app combination with no real deep-link target (confirmed by
 * research before this slice was built: `validator-app` has none at
 * all; `customer-app`'s Ticket and `super-admin-app`'s KycDocument/
 * KybDocument only resolve to a general list, not a specific item —
 * see this phase's own plan for why). */
export type NotificationRouteResolver = (type: string, id: string) => string[] | null;

const RECENT_LIMIT = 20;

function noRoute(): null {
  return null;
}

/**
 * Shared bell-icon notification dropdown — docs/specs/9-notifications.md.
 * Lives in `@layout`, not `shared-ui`: it injects `API_CLIENT`/`AuthStore`
 * and does real data-fetching, the same class of component `NavShell`
 * already is (`shared-ui` stays presentational-only).
 *
 * `client-admin-app`/`super-admin-app` render this via `NavShell`
 * (which has no content-projection slot, so it renders this directly
 * in its own header); `customer-app`/`validator-app` embed it directly
 * in their own bespoke header, since neither uses `NavShell`.
 *
 * Dropdown mechanics deliberately mirror `NavShell`'s own profile-menu
 * pattern exactly (confirmed via research: no CDK Overlay/Menu exists
 * anywhere in this workspace) — a plain `menuOpen` signal, an `@if`-
 * rendered absolutely positioned panel, closed via a document-level
 * click-outside check and Escape, not a second dropdown mechanism.
 *
 * No real-time push (this phase's own non-goal) — fetches once on
 * init and again every time the panel opens, which is this slice's
 * "manual refresh."
 */
@Component({
  selector: 'app-notification-bell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  imports: [Icon],
  template: `
    <div class="relative" #bellRoot>
      <button
        type="button"
        #bellTrigger
        (click)="toggleMenu()"
        aria-haspopup="menu"
        [attr.aria-expanded]="menuOpen()"
        aria-label="Notifications"
        class="relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-slate-500 hover:bg-slate-50 hover:text-slate-900"
      >
        <ui-icon name="bell" [size]="20" />
        @if (unreadCount() > 0) {
          <span
            class="absolute top-1.5 right-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-medium text-white"
          >
            {{ unreadCount() > 99 ? '99+' : unreadCount() }}
          </span>
        }
      </button>

      @if (menuOpen()) {
        <div
          role="menu"
          aria-label="Notifications"
          tabindex="-1"
          class="absolute top-full z-10 mt-1 flex max-h-[70vh] w-80 flex-col rounded-md border border-slate-200 bg-white shadow-lg"
          [class.right-0]="align() === 'right'"
          [class.left-0]="align() === 'left'"
        >
          <div
            class="flex shrink-0 items-center justify-between border-b border-slate-100 px-3 py-2"
          >
            <p class="text-sm font-medium text-slate-900">Notifications</p>
            @if (unreadCount() > 0) {
              <button
                type="button"
                (click)="markAllRead()"
                class="text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                Mark all read
              </button>
            }
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto">
            @if (loading()) {
              <p class="p-3 text-sm text-slate-500">Loading…</p>
            } @else if (error()) {
              <p class="p-3 text-sm text-red-600">{{ error() }}</p>
            } @else if (notifications().length === 0) {
              <p class="p-3 text-sm text-slate-500">No notifications yet.</p>
            } @else {
              @for (notification of notifications(); track notification.id) {
                <button
                  type="button"
                  role="menuitem"
                  (click)="select(notification)"
                  class="flex w-full flex-col gap-0.5 border-b border-slate-50 px-3 py-2 text-left last:border-0 hover:bg-slate-50"
                  [class.bg-slate-50]="!notification.read_at"
                >
                  <span class="text-sm font-medium text-slate-900">{{ notification.title }}</span>
                  <span class="text-xs text-slate-500">{{ notification.body }}</span>
                </button>
              }
            }
          </div>
        </div>
      }
    </div>
  `,
})
export class NotificationBell implements OnInit {
  readonly resolveRoute = input<NotificationRouteResolver>(noRoute);
  // Which edge of the trigger the panel hangs from — 'right' (the
  // default) suits a bell near the right edge of a wide header
  // (customer-app/validator-app); NavShell passes 'left' instead,
  // since its own bell sits near the *right* edge of a *narrow*,
  // left-docked sidebar — a right-anchored w-80 panel there overflows
  // off the left edge of the viewport (caught live, not by a unit
  // test, verifying this slice against the real backend).
  readonly align = input<'left' | 'right'>('right');

  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);

  protected readonly notifications = signal<Notification[]>([]);
  protected readonly unreadCount = signal(0);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly menuOpen = signal(false);

  private readonly bellRoot = viewChild.required<ElementRef<HTMLElement>>('bellRoot');
  private readonly bellTrigger = viewChild.required<ElementRef<HTMLButtonElement>>('bellTrigger');

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  protected toggleMenu(): void {
    const opening = !this.menuOpen();
    this.menuOpen.set(opening);
    if (opening) {
      void this.load();
    }
  }

  protected closeMenu(restoreFocus: boolean): void {
    this.menuOpen.set(false);
    if (restoreFocus) {
      this.bellTrigger().nativeElement.focus();
    }
  }

  @HostListener('document:click', ['$event'])
  protected onDocumentClick(event: MouseEvent): void {
    if (!this.menuOpen()) {
      return;
    }
    if (!this.bellRoot().nativeElement.contains(event.target as Node)) {
      this.closeMenu(false);
    }
  }

  // Same reasoning as NavShell's identical listener: opening the panel
  // never moves focus off the trigger, so a template-level
  // keydown.escape binding on the panel itself would never fire.
  @HostListener('document:keydown.escape')
  protected onDocumentEscape(): void {
    if (this.menuOpen()) {
      this.closeMenu(true);
    }
  }

  private authHeader(): { Authorization: string } {
    return { Authorization: `Bearer ${this.authStore.accessToken()}` };
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    const [recent, unread] = await Promise.all([
      this.api.GET('/api/v1/notifications/mine/', {
        params: { query: { limit: RECENT_LIMIT, offset: 0 } },
        headers: this.authHeader(),
      }),
      // A second, cheap call just for the total unread count — avoids
      // fetching a whole unread page just to read its `count`.
      this.api.GET('/api/v1/notifications/mine/', {
        params: { query: { unread_only: true, limit: 1, offset: 0 } },
        headers: this.authHeader(),
      }),
    ]);
    this.loading.set(false);
    if (!recent.data || !unread.data) {
      this.error.set('Could not load notifications.');
      return;
    }
    this.notifications.set(recent.data.results);
    this.unreadCount.set(unread.data.count);
  }

  protected async select(notification: Notification): Promise<void> {
    if (!notification.read_at) {
      await this.markRead(notification.id);
    }
    this.closeMenu(true);
    const type = notification.related_object_type;
    const id = notification.related_object_id;
    if (!type || !id) {
      return;
    }
    const commands = this.resolveRoute()(type, id);
    if (commands) {
      await this.router.navigate(commands);
    }
  }

  private async markRead(id: string): Promise<void> {
    const { data } = await this.api.POST('/api/v1/notifications/{id}/read/', {
      params: { path: { id } },
      headers: this.authHeader(),
    });
    if (!data) {
      return;
    }
    this.notifications.update((items) => items.map((n) => (n.id === id ? data : n)));
    this.unreadCount.update((count) => Math.max(0, count - 1));
  }

  protected async markAllRead(): Promise<void> {
    const { data } = await this.api.POST('/api/v1/notifications/read-all/', {
      headers: this.authHeader(),
    });
    if (!data) {
      return;
    }
    const now = new Date().toISOString();
    this.notifications.update((items) =>
      items.map((n) => (n.read_at ? n : { ...n, read_at: now }))
    );
    this.unreadCount.set(0);
  }
}
