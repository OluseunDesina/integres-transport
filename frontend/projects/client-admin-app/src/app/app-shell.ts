import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NavShell, type NavItem, type NotificationRouteResolver } from '@layout';

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

  protected readonly navItems: NavItem[] = [
    { label: 'Home', path: '/home', icon: 'home', permissions: [] },
    { label: 'Businesses', path: '/businesses', icon: 'building-office', permissions: ['client.view'] },
    { label: 'Routes', path: '/routes', icon: 'map', permissions: ['network.view'] },
    { label: 'Stops', path: '/stops', icon: 'map-pin', permissions: ['network.view'] },
    {
      label: 'Vehicle Types',
      path: '/vehicle-types',
      icon: 'squares-2x2',
      permissions: ['fleet.view'],
    },
    { label: 'Vehicles', path: '/vehicles', icon: 'truck', permissions: ['fleet.view'] },
    { label: 'Drivers', path: '/drivers', icon: 'user-circle', permissions: ['fleet.view'] },
    {
      label: 'Schedules',
      path: '/schedules',
      icon: 'calendar-days',
      permissions: ['scheduling.view'],
    },
    { label: 'Trips', path: '/trips', icon: 'clock', permissions: ['scheduling.view'] },
    { label: 'Bookings', path: '/bookings', icon: 'document-check', permissions: ['booking.view'] },
    { label: 'Fares', path: '/fares', icon: 'tag', permissions: ['fares.view'] },
    { label: 'Tap & Go', path: '/tap-go', icon: 'bolt', permissions: ['tapngo.view'] },
    { label: 'Payments', path: '/payments', icon: 'banknotes', permissions: ['payments.view'] },
    { label: 'Ledger', path: '/ledger', icon: 'book-open', permissions: ['ledger.view'] },
    {
      label: 'Wallet Lookup',
      path: '/wallet',
      icon: 'credit-card',
      permissions: ['wallet.view'],
    },
    { label: 'Staff', path: '/staff', icon: 'users', permissions: ['staff.manage'] },
    { label: 'KYC Status', path: '/kyc', icon: 'identification', permissions: ['client.view'] },
    { label: 'White Label', path: '/white-label', icon: 'swatch', permissions: ['whitelabel.manage'] },
  ];

  constructor() {
    void this.selectedBusinessStore.ensureLoaded();
  }

  protected onBusinessSelected(id: string): void {
    void this.selectedBusinessStore.select(id);
  }
}
