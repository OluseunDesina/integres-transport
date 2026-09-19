import { Routes } from '@angular/router';
import { permissionGuard } from '@auth';
import { ForbiddenPage } from '@layout';

// Passengers hold no Role/Permission (docs/adr/0003) — same posture
// `customer-app`'s own routes use.
const CUSTOMER_ACCESS = { permissions: ['customer:access'] };

// Pages that own their full width — see `AppShell`'s `FULL_BLEED`.
// Written as a literal key, not imported from the lazily-loaded shell,
// so this file doesn't pull the shell into the main bundle.
const FULL_BLEED_PAGE = { fullBleed: true };

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'search' },
  {
    path: 'login',
    loadComponent: () => import('./login/login').then((m) => m.Login),
  },
  {
    path: 'register',
    loadComponent: () => import('./register/register').then((m) => m.Register),
  },
  {
    path: '',
    loadComponent: () => import('./app-shell').then((m) => m.AppShell),
    children: [
      // Public — docs/specs/22-marketplace.md slice 2: a guest can
      // search and choose seats with no session at all. The one guarded
      // step below (`book`) is the actual point of reservation, the
      // first place a session is required — see `seat-picker.ts`'s own
      // `continueToConfirm()` and `booking-draft.ts`'s `pendingBooking`
      // handoff for how a guest is asked to log in only there, without
      // losing what they had already chosen.
      {
        path: 'search',
        loadComponent: () =>
          import('./trip-search/trip-search').then((m) => m.TripSearch),
        data: FULL_BLEED_PAGE,
      },
      {
        path: 'search/results',
        loadComponent: () =>
          import('./trip-search/search-results').then((m) => m.SearchResults),
        data: FULL_BLEED_PAGE,
      },
      {
        path: 'search/seats',
        loadComponent: () =>
          import('./trip-search/seat-picker').then((m) => m.SeatPicker),
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
    ],
  },
  { path: 'forbidden', component: ForbiddenPage },
];
