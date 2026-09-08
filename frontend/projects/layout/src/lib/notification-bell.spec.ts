import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import type { AuthUser } from '@auth';

import { NotificationBell, type NotificationRouteResolver } from './notification-bell';

type Notification = components['schemas']['Notification'];

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    email: 'owner@example.com',
    firstName: '',
    lastName: '',
    client: 'client-1',
    isPlatformStaff: false,
    isClientStaff: true,
    permissions: [],
    roleName: null,
    clientName: null,
    ...overrides,
  };
}

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'notif-1',
    notification_type: 'license_expiring',
    title: 'Test title',
    body: 'Test body',
    related_object_type: 'Driver',
    related_object_id: 'driver-1',
    read_at: null,
    created_at: '2026-08-20T00:00:00Z',
    ...overrides,
  };
}

describe('NotificationBell', () => {
  let fixture: ComponentFixture<NotificationBell>;
  let apiClient: { GET: jasmine.Spy; POST: jasmine.Spy };

  async function createComponent(resolveRoute?: NotificationRouteResolver): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [NotificationBell],
      providers: [provideRouter([]), { provide: API_CLIENT, useValue: apiClient }],
    }).compileComponents();

    fixture = TestBed.createComponent(NotificationBell);
    if (resolveRoute) {
      fixture.componentRef.setInput('resolveRoute', resolveRoute);
    }
    const authStore = TestBed.inject(AuthStore);
    authStore.setSession('a', 'r', makeUser());
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.clear();
    apiClient = { GET: jasmine.createSpy('GET'), POST: jasmine.createSpy('POST') };
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [] } });
  });

  afterEach(() => localStorage.clear());

  async function openMenu(): Promise<void> {
    const trigger = fixture.debugElement.query(By.css('[aria-haspopup="menu"]'));
    trigger.nativeElement.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('fetches the recent list and unread count on init', async () => {
    await createComponent();

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/notifications/mine/',
      jasmine.objectContaining({ params: { query: { limit: 20, offset: 0 } } })
    );
    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/notifications/mine/',
      jasmine.objectContaining({
        params: { query: { unread_only: true, limit: 1, offset: 0 } },
      })
    );
  });

  it('shows an unread badge with the total unread count', async () => {
    apiClient.GET.and.callFake((_path: string, options: { params: { query: Record<string, unknown> } }) =>
      Promise.resolve(
        options.params.query['unread_only']
          ? { data: { count: 3, results: [] } }
          : { data: { count: 3, results: [makeNotification()] } }
      )
    );
    await createComponent();

    expect(fixture.nativeElement.textContent).toContain('3');
  });

  it('shows no badge when there are no unread notifications', async () => {
    await createComponent();

    const badge = fixture.debugElement.query(By.css('.bg-red-600'));
    expect(badge).toBeNull();
  });

  it('is closed by default and opens on trigger click, refetching', async () => {
    await createComponent();
    apiClient.GET.calls.reset();
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [makeNotification()] } });

    expect(fixture.debugElement.query(By.css('[role="menu"]'))).toBeNull();

    await openMenu();

    expect(fixture.debugElement.query(By.css('[role="menu"]'))).toBeTruthy();
    expect(apiClient.GET).toHaveBeenCalled();
  });

  it('shows an empty state when there are no notifications', async () => {
    await createComponent();
    await openMenu();

    expect(fixture.nativeElement.textContent).toContain('No notifications yet.');
  });

  it('lists recent notifications once opened', async () => {
    apiClient.GET.and.resolveTo({
      data: { count: 1, results: [makeNotification({ title: 'License expiring soon' })] },
    });
    await createComponent();
    await openMenu();

    expect(fixture.nativeElement.textContent).toContain('License expiring soon');
  });

  /**
   * Unread was signalled by a `bg-slate-50` tint and nothing else —
   * colour as the only status indicator, against this repo's own bar,
   * and a tint faint enough to be barely a colour. A screen-reader user
   * got no signal at all.
   */
  it('marks an unread row with more than a background tint', async () => {
    apiClient.GET.and.resolveTo({
      data: { count: 1, results: [makeNotification({ read_at: null })] },
    });
    await createComponent();
    await openMenu();

    const row = (fixture.nativeElement as HTMLElement).querySelector('[role="menuitem"]');
    expect(row?.querySelector('.sr-only')?.textContent?.trim()).toBe('Unread.');
    expect(row?.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('says nothing extra about a row that has been read', async () => {
    apiClient.GET.and.resolveTo({
      data: { count: 0, results: [makeNotification({ read_at: '2026-08-19T00:00:00Z' })] },
    });
    await createComponent();
    await openMenu();

    const row = (fixture.nativeElement as HTMLElement).querySelector('[role="menuitem"]');
    expect(row?.textContent).not.toContain('Unread');
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    await createComponent();
    await openMenu();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('[role="menu"]'))).toBeNull();
    const trigger = fixture.debugElement.query(By.css('[aria-haspopup="menu"]'));
    expect(document.activeElement).toBe(trigger.nativeElement);
  });

  it('closes when clicking outside the menu', async () => {
    await createComponent();
    await openMenu();
    expect(fixture.debugElement.query(By.css('[role="menu"]'))).toBeTruthy();

    document.body.click();
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('[role="menu"]'))).toBeNull();
  });

  it('marks a notification read on click, decrements the badge, and does not navigate with no resolver', async () => {
    apiClient.GET.and.callFake((_path: string, options: { params: { query: Record<string, unknown> } }) =>
      Promise.resolve(
        options.params.query['unread_only']
          ? { data: { count: 1, results: [] } }
          : { data: { count: 1, results: [makeNotification()] } }
      )
    );
    apiClient.POST.and.resolveTo({ data: makeNotification({ read_at: '2026-08-20T01:00:00Z' }) });
    await createComponent();
    await openMenu();
    const router = TestBed.inject(Router);
    const navigateSpy = spyOn(router, 'navigate');

    const row = fixture.debugElement.query(By.css('[role="menuitem"]'));
    row.nativeElement.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/notifications/{id}/read/',
      jasmine.objectContaining({ params: { path: { id: 'notif-1' } } })
    );
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(fixture.debugElement.query(By.css('.bg-red-600'))).toBeNull();
  });

  it('navigates using the supplied resolveRoute after marking read', async () => {
    apiClient.GET.and.resolveTo({ data: { count: 0, results: [makeNotification()] } });
    apiClient.POST.and.resolveTo({ data: makeNotification({ read_at: '2026-08-20T01:00:00Z' }) });
    const resolveRoute: NotificationRouteResolver = (type, id) =>
      type === 'Driver' ? ['/drivers', id, 'edit'] : null;
    await createComponent(resolveRoute);
    await openMenu();
    const router = TestBed.inject(Router);
    const navigateSpy = spyOn(router, 'navigate').and.resolveTo(true);

    const row = fixture.debugElement.query(By.css('[role="menuitem"]'));
    row.nativeElement.click();
    await fixture.whenStable();

    expect(navigateSpy).toHaveBeenCalledWith(['/drivers', 'driver-1', 'edit']);
  });

  it('does not call read again for an already-read notification', async () => {
    apiClient.GET.and.resolveTo({
      data: { count: 0, results: [makeNotification({ read_at: '2026-08-19T00:00:00Z' })] },
    });
    await createComponent();
    await openMenu();

    const row = fixture.debugElement.query(By.css('[role="menuitem"]'));
    row.nativeElement.click();
    await fixture.whenStable();

    expect(apiClient.POST).not.toHaveBeenCalled();
  });

  it('mark-all-read clears the badge and marks every row read', async () => {
    apiClient.GET.and.callFake((_path: string, options: { params: { query: Record<string, unknown> } }) =>
      Promise.resolve(
        options.params.query['unread_only']
          ? { data: { count: 2, results: [] } }
          : {
              data: {
                count: 2,
                results: [makeNotification({ id: 'n1' }), makeNotification({ id: 'n2' })],
              },
            }
      )
    );
    apiClient.POST.and.resolveTo({ data: { marked_read: 2 } });
    await createComponent();
    await openMenu();

    const markAllButton = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button')
    ).find((el) => el.textContent?.trim() === 'Mark all read');
    markAllButton?.dispatchEvent(new Event('click'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(apiClient.POST).toHaveBeenCalledWith(
      '/api/v1/notifications/read-all/',
      jasmine.anything()
    );
    expect(fixture.debugElement.query(By.css('.bg-red-600'))).toBeNull();
    const rows = fixture.debugElement.queryAll(By.css('[role="menuitem"]'));
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect((row.nativeElement as HTMLElement).classList.contains('bg-slate-50')).toBeFalse();
    }
  });

  it('does not show the "Mark all read" action when there is nothing unread', async () => {
    await createComponent();
    await openMenu();

    const markAllButton = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button')
    ).find((el) => el.textContent?.trim() === 'Mark all read');
    expect(markAllButton).toBeUndefined();
  });

  it('surfaces a load error', async () => {
    apiClient.GET.and.resolveTo({ error: { detail: 'nope' } });
    await createComponent();
    await openMenu();

    expect(fixture.nativeElement.textContent).toContain('Could not load notifications.');
  });

  it('anchors the panel to the right by default, and to the left when align="left"', async () => {
    await createComponent();
    await openMenu();
    let panel = fixture.debugElement.query(By.css('[role="menu"]'));
    expect((panel.nativeElement as HTMLElement).classList.contains('right-0')).toBeTrue();
    expect((panel.nativeElement as HTMLElement).classList.contains('left-0')).toBeFalse();

    fixture.componentRef.setInput('align', 'left');
    fixture.detectChanges();

    panel = fixture.debugElement.query(By.css('[role="menu"]'));
    expect((panel.nativeElement as HTMLElement).classList.contains('left-0')).toBeTrue();
    expect((panel.nativeElement as HTMLElement).classList.contains('right-0')).toBeFalse();
  });
});
