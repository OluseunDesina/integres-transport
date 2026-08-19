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
        path: 'record',
        loadComponent: () => import('./record-tap/record-tap').then((m) => m.RecordTap),
        canActivate: [permissionGuard],
        data: { permissions: ['tapngo.record'] },
      },
      {
        path: 'validate-ticket',
        loadComponent: () =>
          import('./validate-ticket/validate-ticket').then((m) => m.ValidateTicket),
        canActivate: [permissionGuard],
        data: { permissions: ['ticketing.validate'] },
      },
    ],
  },
  { path: 'forbidden', component: ForbiddenPage },
];
