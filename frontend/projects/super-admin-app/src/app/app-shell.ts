import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NavShell, type NavItem } from '@layout';

@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NavShell],
  template: `<app-nav-shell appName="Super Admin" [navItems]="navItems" />`,
})
export class AppShell {
  protected readonly navItems: NavItem[] = [
    { label: 'Home', path: '/home', icon: 'home', permissions: [] },
    { label: 'KYC Queue', path: '/kyc-queue', icon: 'clipboard-document-check', permissions: ['super-admin:access'] },
    { label: 'KYB Queue', path: '/kyb-queue', icon: 'document-check', permissions: ['super-admin:access'] },
    { label: 'Businesses', path: '/businesses', icon: 'building-office', permissions: ['super-admin:access'] },
    { label: 'Invite Client', path: '/invite-client', icon: 'user-plus', permissions: ['super-admin:access'] },
  ];
}
