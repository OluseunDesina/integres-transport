import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NavShell, type NavItem, type NotificationRouteResolver } from '@layout';

// docs/specs/9-notifications.md: this app's own recipients are
// KYC/KYB-submission notifications. Neither queue screen supports a
// deep link to one specific document (both are flat lists with no
// id-based route — confirmed before this slice was built), so this
// resolves to the general queue, not a specific item.
const resolveNotificationRoute: NotificationRouteResolver = (type) => {
  switch (type) {
    case 'KycDocument':
      return ['/kyc-queue'];
    case 'KybDocument':
      return ['/kyb-queue'];
    default:
      return null;
  }
};

@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NavShell],
  template: `<app-nav-shell
    appName="Super Admin"
    [navItems]="navItems"
    [resolveNotificationRoute]="resolveNotificationRoute"
  />`,
})
export class AppShell {
  protected readonly resolveNotificationRoute = resolveNotificationRoute;
  // Sentence case, matching the headings these link to. Four of the
  // five were Title Case, so the nav read as two lists spliced
  // together — the same defect slice 4 fixed in client-admin (F4).
  protected readonly navItems: NavItem[] = [
    { label: 'Home', path: '/home', icon: 'home', permissions: [] },
    { label: 'KYC queue', path: '/kyc-queue', icon: 'clipboard-document-check', permissions: ['super-admin:access'] },
    { label: 'KYB queue', path: '/kyb-queue', icon: 'document-check', permissions: ['super-admin:access'] },
    { label: 'Businesses', path: '/businesses', icon: 'building-office', permissions: ['super-admin:access'] },
    { label: 'Invite a client', path: '/invite-client', icon: 'user-plus', permissions: ['super-admin:access'] },
  ];
}
