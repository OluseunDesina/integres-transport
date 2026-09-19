import { Routes } from '@angular/router';
import { permissionGuard } from '@auth';
import { ForbiddenPage } from '@layout';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'login' },
  {
    path: 'login',
    loadComponent: () => import('./login/login').then((m) => m.Login),
  },
  {
    path: '',
    loadComponent: () => import('./app-shell').then((m) => m.AppShell),
    children: [
      {
        path: 'home',
        loadComponent: () => import('./home/home').then((m) => m.Home),
        canActivate: [permissionGuard],
        data: { permissions: ['super-admin:access'] },
      },
      {
        path: 'kyc-queue',
        loadComponent: () => import('./kyc-queue/kyc-queue').then((m) => m.KycQueue),
        canActivate: [permissionGuard],
        data: { permissions: ['super-admin:access'] },
      },
      {
        path: 'businesses',
        loadComponent: () =>
          import('./businesses/business-list/business-list').then((m) => m.BusinessList),
        canActivate: [permissionGuard],
        data: { permissions: ['super-admin:access'] },
      },
      {
        path: 'businesses/:id/paystack-account',
        loadComponent: () =>
          import('./businesses/paystack-config/paystack-config').then((m) => m.PaystackConfig),
        canActivate: [permissionGuard],
        data: { permissions: ['super-admin:access'] },
      },
      {
        path: 'businesses/:id/settlement-runs',
        loadComponent: () =>
          import('./businesses/settlement-runs/settlement-runs').then((m) => m.SettlementRuns),
        canActivate: [permissionGuard],
        data: { permissions: ['super-admin:access'] },
      },
      {
        path: 'businesses/:id/seat-hold',
        loadComponent: () => import('./businesses/seat-hold/seat-hold').then((m) => m.SeatHold),
        canActivate: [permissionGuard],
        data: { permissions: ['super-admin:access'] },
      },
      {
        path: 'invite-client',
        loadComponent: () =>
          import('./client-invite/client-invite').then((m) => m.ClientInvite),
        canActivate: [permissionGuard],
        data: { permissions: ['super-admin:access'] },
      },
    ],
  },
  { path: 'forbidden', component: ForbiddenPage },
];
