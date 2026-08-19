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
    path: 'register',
    loadComponent: () => import('./register/register').then((m) => m.Register),
  },
  {
    path: '',
    loadComponent: () => import('./app-shell').then((m) => m.AppShell),
    children: [
      {
        path: 'home',
        loadComponent: () => import('./home/home').then((m) => m.Home),
        canActivate: [permissionGuard],
        data: { permissions: ['client-admin:access'] },
      },
      {
        path: 'businesses',
        loadComponent: () =>
          import('./businesses/business-list/business-list').then((m) => m.BusinessList),
        canActivate: [permissionGuard],
        data: { permissions: ['client.view'] },
      },
      {
        path: 'businesses/new',
        loadComponent: () =>
          import('./businesses/business-form/business-form').then((m) => m.BusinessForm),
        canActivate: [permissionGuard],
        data: { permissions: ['business.manage'] },
      },
      {
        path: 'businesses/:id/edit',
        loadComponent: () =>
          import('./businesses/business-form/business-form').then((m) => m.BusinessForm),
        canActivate: [permissionGuard],
        data: { permissions: ['business.manage'] },
      },
      {
        path: 'routes',
        loadComponent: () => import('./routes/route-list/route-list').then((m) => m.RouteList),
        canActivate: [permissionGuard],
        data: { permissions: ['network.view'] },
      },
      {
        path: 'routes/new',
        loadComponent: () => import('./routes/route-form/route-form').then((m) => m.RouteForm),
        canActivate: [permissionGuard],
        data: { permissions: ['network.manage'] },
      },
      {
        path: 'routes/:id/edit',
        loadComponent: () => import('./routes/route-form/route-form').then((m) => m.RouteForm),
        canActivate: [permissionGuard],
        data: { permissions: ['network.manage'] },
      },
      {
        path: 'stops',
        loadComponent: () => import('./stops/stop-list/stop-list').then((m) => m.StopList),
        canActivate: [permissionGuard],
        data: { permissions: ['network.view'] },
      },
      {
        path: 'stops/new',
        loadComponent: () => import('./stops/stop-form/stop-form').then((m) => m.StopForm),
        canActivate: [permissionGuard],
        data: { permissions: ['network.manage'] },
      },
      {
        path: 'stops/:id/edit',
        loadComponent: () => import('./stops/stop-form/stop-form').then((m) => m.StopForm),
        canActivate: [permissionGuard],
        data: { permissions: ['network.manage'] },
      },
      {
        path: 'vehicle-types',
        loadComponent: () =>
          import('./vehicle-types/vehicle-type-list/vehicle-type-list').then(
            (m) => m.VehicleTypeList
          ),
        canActivate: [permissionGuard],
        data: { permissions: ['fleet.view'] },
      },
      {
        path: 'vehicle-types/new',
        loadComponent: () =>
          import('./vehicle-types/vehicle-type-form/vehicle-type-form').then(
            (m) => m.VehicleTypeForm
          ),
        canActivate: [permissionGuard],
        data: { permissions: ['fleet.manage'] },
      },
      {
        path: 'vehicle-types/:id/edit',
        loadComponent: () =>
          import('./vehicle-types/vehicle-type-form/vehicle-type-form').then(
            (m) => m.VehicleTypeForm
          ),
        canActivate: [permissionGuard],
        data: { permissions: ['fleet.manage'] },
      },
      {
        path: 'vehicles',
        loadComponent: () =>
          import('./vehicles/vehicle-list/vehicle-list').then((m) => m.VehicleList),
        canActivate: [permissionGuard],
        data: { permissions: ['fleet.view'] },
      },
      {
        path: 'vehicles/new',
        loadComponent: () =>
          import('./vehicles/vehicle-form/vehicle-form').then((m) => m.VehicleForm),
        canActivate: [permissionGuard],
        data: { permissions: ['fleet.manage'] },
      },
      {
        path: 'vehicles/:id/edit',
        loadComponent: () =>
          import('./vehicles/vehicle-form/vehicle-form').then((m) => m.VehicleForm),
        canActivate: [permissionGuard],
        data: { permissions: ['fleet.manage'] },
      },
      {
        path: 'drivers',
        loadComponent: () => import('./drivers/driver-list/driver-list').then((m) => m.DriverList),
        canActivate: [permissionGuard],
        data: { permissions: ['fleet.view'] },
      },
      {
        path: 'drivers/new',
        loadComponent: () => import('./drivers/driver-form/driver-form').then((m) => m.DriverForm),
        canActivate: [permissionGuard],
        data: { permissions: ['fleet.manage'] },
      },
      {
        path: 'drivers/:id/edit',
        loadComponent: () => import('./drivers/driver-form/driver-form').then((m) => m.DriverForm),
        canActivate: [permissionGuard],
        data: { permissions: ['fleet.manage'] },
      },
      {
        path: 'schedules',
        loadComponent: () =>
          import('./schedules/schedule-list/schedule-list').then((m) => m.ScheduleList),
        canActivate: [permissionGuard],
        data: { permissions: ['scheduling.view'] },
      },
      {
        path: 'schedules/new',
        loadComponent: () =>
          import('./schedules/schedule-form/schedule-form').then((m) => m.ScheduleForm),
        canActivate: [permissionGuard],
        data: { permissions: ['scheduling.manage'] },
      },
      {
        path: 'schedules/:id/edit',
        loadComponent: () =>
          import('./schedules/schedule-form/schedule-form').then((m) => m.ScheduleForm),
        canActivate: [permissionGuard],
        data: { permissions: ['scheduling.manage'] },
      },
      {
        path: 'trips',
        loadComponent: () => import('./trips/trip-list/trip-list').then((m) => m.TripList),
        canActivate: [permissionGuard],
        data: { permissions: ['scheduling.view'] },
      },
      {
        path: 'trips/new',
        loadComponent: () => import('./trips/trip-form/trip-form').then((m) => m.TripForm),
        canActivate: [permissionGuard],
        data: { permissions: ['scheduling.manage'] },
      },
      {
        path: 'bookings',
        loadComponent: () =>
          import('./bookings/booking-list/booking-list').then((m) => m.BookingList),
        canActivate: [permissionGuard],
        data: { permissions: ['booking.view'] },
      },
      {
        path: 'payments',
        loadComponent: () =>
          import('./payments/payment-list/payment-list').then((m) => m.PaymentList),
        canActivate: [permissionGuard],
        data: { permissions: ['payments.view'] },
      },
      {
        path: 'ledger',
        loadComponent: () =>
          import('./ledger/ledger-overview/ledger-overview').then((m) => m.LedgerOverview),
        canActivate: [permissionGuard],
        data: { permissions: ['ledger.view'] },
      },
      {
        path: 'wallet',
        loadComponent: () =>
          import('./wallet/wallet-lookup/wallet-lookup').then((m) => m.WalletLookup),
        canActivate: [permissionGuard],
        data: { permissions: ['wallet.view'] },
      },
      {
        path: 'staff',
        loadComponent: () => import('./staff/staff-list/staff-list').then((m) => m.StaffList),
        canActivate: [permissionGuard],
        data: { permissions: ['staff.manage'] },
      },
      {
        path: 'staff/invite',
        loadComponent: () =>
          import('./staff/staff-invite/staff-invite').then((m) => m.StaffInvite),
        canActivate: [permissionGuard],
        data: { permissions: ['staff.invite'] },
      },
      {
        path: 'kyc',
        loadComponent: () => import('./kyc-status/kyc-status').then((m) => m.KycStatus),
        canActivate: [permissionGuard],
        data: { permissions: ['client.view'] },
      },
      {
        path: 'white-label',
        loadComponent: () => import('./white-label/white-label').then((m) => m.WhiteLabel),
        canActivate: [permissionGuard],
        data: { permissions: ['whitelabel.manage'] },
      },
    ],
  },
  { path: 'forbidden', component: ForbiddenPage },
];
