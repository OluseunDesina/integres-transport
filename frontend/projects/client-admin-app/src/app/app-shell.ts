import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NavShell, type NavItem, type NotificationRouteResolver, type QuickAction } from '@layout';

import { SelectedBusinessStore } from './shared/data/store/selected-business.store';

// docs/specs/9-notifications.md: this app's own recipients are
// Driver/Vehicle compliance-expiry notifications — both routes already
// exist (fleet.manage-gated, same as navigating there any other way).
// Anything else (this app has no other trigger type today) falls
// through to "mark read, don't navigate."
const resolveNotificationRoute: NotificationRouteResolver = (type, id) => {
  switch (type) {
    case 'Driver':
      return ['/drivers', id, 'edit'];
    case 'Vehicle':
      return ['/vehicles', id, 'edit'];
    default:
      return null;
  }
};

@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NavShell],
  template: `
    <app-nav-shell
      appName="Client Admin"
      [navItems]="navItems"
      [businesses]="businesses()"
      [activeBusinessId]="selectedBusinessStore.selectedBusinessId()"
      [resolveNotificationRoute]="resolveNotificationRoute"
      [quickActions]="quickActions"
      (businessSelected)="onBusinessSelected($event)"
    />
  `,
})
export class AppShell {
  protected readonly resolveNotificationRoute = resolveNotificationRoute;
  protected readonly selectedBusinessStore = inject(SelectedBusinessStore);

  protected readonly businesses = computed(() =>
    this.selectedBusinessStore.items().map((business) => ({ id: business.id, name: business.name }))
  );

  /**
   * The top bar's "New…" menu — spec 14 slice 3a. Everything an operator
   * creates day to day, reachable from any screen instead of only from
   * the list it belongs to.
   *
   * Deliberately not every create route in the app: a Business or a
   * staff invitation is an occasional administrative act, not part of
   * the daily loop, and padding the menu with them would make the
   * frequent ones harder to find.
   *
   * Same permission codenames the nav items use, so a create a user
   * cannot perform is never offered.
   */
  protected readonly quickActions: QuickAction[] = [
    {
      label: 'New route',
      path: '/routes/new',
      permissions: ['network.manage'],
    },
    { label: 'New stop', path: '/stops/new', permissions: ['network.manage'] },
    {
      label: 'New vehicle type',
      path: '/vehicle-types/new',
      permissions: ['fleet.manage'],
    },
    {
      label: 'New vehicle',
      path: '/vehicles/new',
      permissions: ['fleet.manage'],
    },
    {
      label: 'New driver',
      path: '/drivers/new',
      permissions: ['fleet.manage'],
    },
    {
      label: 'New schedule',
      path: '/schedules/new',
      permissions: ['scheduling.manage'],
    },
    {
      label: 'New trip',
      path: '/trips/new',
      permissions: ['scheduling.manage'],
    },
    {
      label: 'Report an incident',
      path: '/incidents/new',
      permissions: ['incidents.manage'],
    },
  ];

  protected readonly navItems: NavItem[] = [
    // Spec 16 slice 3: still `/home` (every landing redirect points
    // there), but the screen is the dashboard now and the nav says so.
    // Permissions stay empty — this is where Staff lands too, and the
    // screen itself decides what it can show them.
    { label: 'Dashboard', path: '/home', icon: 'chart-bar', permissions: [] },
    {
      label: 'Businesses',
      path: '/businesses',
      icon: 'building-office',
      permissions: ['client.view'],
    },
    {
      label: 'Routes',
      path: '/routes',
      icon: 'map',
      permissions: ['network.view'],
    },
    {
      label: 'Stops',
      path: '/stops',
      icon: 'map-pin',
      permissions: ['network.view'],
    },
    {
      label: 'Vehicle types',
      path: '/vehicle-types',
      icon: 'squares-2x2',
      permissions: ['fleet.view'],
    },
    {
      label: 'Vehicles',
      path: '/vehicles',
      icon: 'truck',
      permissions: ['fleet.view'],
    },
    {
      label: 'Drivers',
      path: '/drivers',
      icon: 'user-circle',
      permissions: ['fleet.view'],
    },
    {
      label: 'Schedules',
      path: '/schedules',
      icon: 'calendar-days',
      permissions: ['scheduling.view'],
    },
    {
      label: 'Trips',
      path: '/trips',
      icon: 'clock',
      permissions: ['scheduling.view'],
    },
    {
      label: 'Live operations',
      path: '/live-operations',
      icon: 'signal',
      permissions: ['scheduling.view'],
    },
    {
      label: 'Bookings',
      path: '/bookings',
      icon: 'document-check',
      permissions: ['booking.view'],
    },
    {
      label: 'Fares',
      path: '/fares',
      icon: 'tag',
      permissions: ['fares.view'],
    },
    // "Pay as you go", not "Tap & Go", as of
    // docs/specs/10-booking-modes.md: what this screen lists is
    // `FareJourney` rows, which only exist where the fare is charged
    // after travel. A tap credential itself is now usable in any mode,
    // so labelling this by the tap would name the wrong half. The route
    // path stays `/tap-go` — a URL nobody reads is not worth breaking
    // every bookmark and link over.
    {
      label: 'Pay as you go',
      path: '/tap-go',
      icon: 'bolt',
      permissions: ['tapngo.view'],
    },
    {
      label: 'Revenue',
      path: '/revenue',
      icon: 'chart-bar',
      permissions: ['analytics.view'],
    },
    {
      label: 'Incidents',
      path: '/incidents',
      icon: 'exclamation-triangle',
      permissions: ['incidents.view'],
    },
    {
      label: 'Payments',
      path: '/payments',
      icon: 'banknotes',
      permissions: ['payments.view'],
    },
    {
      label: 'Ledger',
      path: '/ledger',
      icon: 'book-open',
      permissions: ['ledger.view'],
    },
    {
      label: 'Wallet lookup',
      path: '/wallet',
      icon: 'credit-card',
      permissions: ['wallet.view'],
    },
    {
      label: 'Staff',
      path: '/staff',
      icon: 'users',
      permissions: ['staff.manage'],
    },
    {
      label: 'KYC status',
      path: '/kyc',
      icon: 'identification',
      permissions: ['client.view'],
    },
    {
      label: 'White label',
      path: '/white-label',
      icon: 'swatch',
      permissions: ['whitelabel.manage'],
    },
  ];

  constructor() {
    void this.selectedBusinessStore.ensureLoaded();
  }

  protected onBusinessSelected(id: string): void {
    void this.selectedBusinessStore.select(id);
  }
}
