import { Routes } from '@angular/router';
import { permissionGuard } from '@auth';
import { ForbiddenPage } from '@layout';

// Passengers hold no Role/Permission (docs/adr/0003), so every
// authenticated screen here sits behind the same `customer:access`
// audience claim `home` already used — there is no finer-grained
// codename to gate the booking flow on, and inventing one would imply a
// staff-style RBAC model passengers don't have.
const CUSTOMER_ACCESS = { permissions: ['customer:access'] };

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
        data: CUSTOMER_ACCESS,
      },
      {
        path: 'search',
        loadComponent: () =>
          import('./trip-search/trip-search').then((m) => m.TripSearch),
        canActivate: [permissionGuard],
        data: CUSTOMER_ACCESS,
      },
      {
        path: 'search/seats',
        loadComponent: () =>
          import('./trip-search/seat-picker').then((m) => m.SeatPicker),
        canActivate: [permissionGuard],
        data: CUSTOMER_ACCESS,
      },
      {
        path: 'book',
        loadComponent: () =>
          import('./booking/booking-confirm').then((m) => m.BookingConfirm),
        canActivate: [permissionGuard],
        data: CUSTOMER_ACCESS,
      },
      {
        path: 'my-bookings',
        loadComponent: () => import('./booking/my-bookings').then((m) => m.MyBookings),
        canActivate: [permissionGuard],
        data: CUSTOMER_ACCESS,
      },
      {
        path: 'my-bookings/:id/tickets',
        loadComponent: () =>
          import('./booking/booking-tickets').then((m) => m.BookingTickets),
        canActivate: [permissionGuard],
        data: CUSTOMER_ACCESS,
      },
      {
        path: 'credentials',
        loadComponent: () =>
          import('./credential/my-credentials').then((m) => m.MyCredentials),
        canActivate: [permissionGuard],
        data: CUSTOMER_ACCESS,
      },
      {
        path: 'journeys',
        loadComponent: () => import('./journeys/journeys').then((m) => m.Journeys),
        canActivate: [permissionGuard],
        data: CUSTOMER_ACCESS,
      },
      {
        path: 'payments',
        loadComponent: () => import('./payments/payments').then((m) => m.Payments),
        canActivate: [permissionGuard],
        data: CUSTOMER_ACCESS,
      },
      {
        path: 'wallet',
        loadComponent: () => import('./wallet/wallet').then((m) => m.WalletScreen),
        canActivate: [permissionGuard],
        data: CUSTOMER_ACCESS,
      },
    ],
  },
  { path: 'forbidden', component: ForbiddenPage },
];
