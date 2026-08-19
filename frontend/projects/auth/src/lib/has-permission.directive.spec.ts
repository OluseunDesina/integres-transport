import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AuthStore } from './auth-store';
import type { AuthUser } from './auth-user';
import { HasPermissionDirective } from './has-permission.directive';

const platformStaff: AuthUser = {
  id: 'user-1',
  email: 'admin@integra.example.com',
  firstName: '',
  lastName: '',
  client: null,
  isPlatformStaff: true,
  isClientStaff: false,
  permissions: ['super-admin:access'],
  roleName: null,
  clientName: null,
};

@Component({
  imports: [HasPermissionDirective],
  template: `
    <div *appHasPermission="'super-admin:access'" data-testid="single">single</div>
    <div *appHasPermission="['client-admin:access', 'super-admin:access']" data-testid="any-of">
      any-of
    </div>
    <div *appHasPermission="'client-admin:access'" data-testid="denied">denied</div>
  `,
})
class HostComponent {}

describe('HasPermissionDirective', () => {
  let fixture: ComponentFixture<HostComponent>;
  let authStore: AuthStore;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    authStore = TestBed.inject(AuthStore);
  });

  afterEach(() => localStorage.clear());

  function query(testId: string): Element | null {
    return (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${testId}"]`);
  }

  it('renders nothing for any permission when signed out', () => {
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    expect(query('single')).toBeNull();
    expect(query('any-of')).toBeNull();
    expect(query('denied')).toBeNull();
  });

  it('renders matching permission checks and hides non-matching ones', () => {
    authStore.setSession('a', 'r', platformStaff);
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    expect(query('single')).not.toBeNull();
    expect(query('any-of')).not.toBeNull();
    expect(query('denied')).toBeNull();
  });
});
