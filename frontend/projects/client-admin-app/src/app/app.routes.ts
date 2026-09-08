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
    path: 'register/invite/:token',
    loadComponent: () =>
      import('./register/client-invite-accept/client-invite-accept').then(
        (m) => m.ClientInviteAccept
      ),
  },
  {
    path: 'staff/accept/:token',
    loadComponent: () =>
      import('./staff/staff-invite-accept/staff-invite-accept').then((m) => m.StaffInviteAccept),
  },
  {
    path: '',
    loadComponent: () => import('./app-shell').then((m) => m.AppShell),
    children: [
      {
        // Spec 16 slice 3 replaced `home` with the dashboard, at the same
        // path so every existing landing redirect keeps working.
        //
        // Deliberately still gated on `client-admin:access`, not
        // `analytics.view`: this is where every user lands after signing
        // in, and the Staff preset does not carry `analytics.view`.
        // Gating it would forbid Staff their own landing page. The
        // component asks for the codename itself and renders accordingly.
        path: 'home',
        loadComponent: () => import('./dashboard/dashboard').then((m) => m.Dashboard),
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
        // Gated on client.view, not business.manage: uploading is
        // kyb.submit and adding directors is business.manage, but a
        // read-only viewer should still be able to see how far the
        // verification packet has got. The screen hides the write
        // controls it can't use.
        path: 'businesses/:id/kyb',
        loadComponent: () =>
          import('./businesses/business-kyb/business-kyb').then((m) => m.BusinessKyb),
        canActivate: [permissionGuard],
        data: { permissions: ['client.view'] },
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
        path: 'routes/:id',
        loadComponent: () =>
          import('./routes/route-detail/route-detail').then((m) => m.RouteDetail),
        canActivate: [permissionGuard],
        data: { permissions: ['network.view'] },
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
        path: 'vehicle-types/:id/seats',
        loadComponent: () => import('./vehicle-types/seat-map/seat-map').then((m) => m.SeatMap),
        canActivate: [permissionGuard],
        data: { permissions: ['seating.view'] },
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
        // `scheduling.view`: live monitoring is scheduling visibility,
        // not a new capability — docs/specs/20-live-operations.md's own
        // reasoning for why this needed no new permission codename.
        path: 'live-operations',
        loadComponent: () =>
          import('./live-operations/live-operations').then((m) => m.LiveOperations),
        canActivate: [permissionGuard],
        data: { permissions: ['scheduling.view'] },
      },
      {
        // Gated on `analytics.view`, not `scheduling.view`: this is
        // revenue reporting for one departure, and the same sensitivity
        // line slice 1 drew (Owner and Manager, not Staff) applies here.
        path: 'trips/:id/performance',
        loadComponent: () =>
          import('./trips/trip-performance/trip-performance').then((m) => m.TripPerformance),
        canActivate: [permissionGuard],
        data: { permissions: ['analytics.view'] },
      },
      {
        // `booking.view`, deliberately not the `analytics.view` its
        // neighbour above carries. The manifest is not revenue
        // reporting — it is the list a conductor reads at the door, and
        // the Staff preset holds `booking.view` precisely so frontline
        // staff can reach exactly this sort of thing.
        path: 'trips/:id/manifest',
        loadComponent: () =>
          import('./trips/trip-manifest/trip-manifest').then((m) => m.TripManifest),
        canActivate: [permissionGuard],
        data: { permissions: ['booking.view'] },
      },
      {
        path: 'revenue',
        loadComponent: () =>
          import('./revenue/revenue-report').then((m) => m.RevenueReport),
        canActivate: [permissionGuard],
        data: { permissions: ['analytics.view'] },
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
        // `booking.manage`, not `booking.view` — Owner and Manager hold
        // it and Staff deliberately do not. Reading who is aboard and
        // creating a financial obligation for someone else are
        // different authorities (spec 18 slice 2).
        path: 'bookings/counter',
        loadComponent: () =>
          import('./bookings/counter-booking/counter-booking').then((m) => m.CounterBooking),
        canActivate: [permissionGuard],
        data: { permissions: ['booking.manage'] },
      },
      {
        path: 'fares',
        loadComponent: () => import('./fares/fare-list/fare-list').then((m) => m.FareList),
        canActivate: [permissionGuard],
        data: { permissions: ['fares.view'] },
      },
      {
        path: 'fares/new',
        loadComponent: () => import('./fares/fare-form/fare-form').then((m) => m.FareForm),
        canActivate: [permissionGuard],
        data: { permissions: ['fares.manage'] },
      },
      {
        // fares.view, not fares.manage: the grid is the clearest view
        // of what a route actually charges, so a read-only viewer
        // should reach it. The screen disables its cells and hides the
        // save button when the session can't write.
        path: 'fares/fare-matrix/:routeId',
        loadComponent: () => import('./fares/fare-matrix/fare-matrix').then((m) => m.FareMatrix),
        canActivate: [permissionGuard],
        data: { permissions: ['fares.view'] },
      },
      {
        path: 'tap-go',
        loadComponent: () =>
          import('./tap-go/fare-journey-list/fare-journey-list').then((m) => m.FareJourneyList),
        canActivate: [permissionGuard],
        data: { permissions: ['tapngo.view'] },
      },
      {
        path: 'incidents',
        loadComponent: () =>
          import('./incidents/incident-list/incident-list').then((m) => m.IncidentList),
        canActivate: [permissionGuard],
        data: { permissions: ['incidents.view'] },
      },
      {
        path: 'incidents/new',
        loadComponent: () =>
          import('./incidents/incident-form/incident-form').then((m) => m.IncidentForm),
        canActivate: [permissionGuard],
        data: { permissions: ['incidents.manage'] },
      },
      {
        // Above `incidents/:id` — a literal segment would otherwise be
        // read as an id and 404 against the detail endpoint.
        path: 'incidents/:id/edit',
        loadComponent: () =>
          import('./incidents/incident-form/incident-form').then((m) => m.IncidentForm),
        canActivate: [permissionGuard],
        data: { permissions: ['incidents.manage'] },
      },
      {
        path: 'incidents/:id',
        loadComponent: () =>
          import('./incidents/incident-detail/incident-detail').then((m) => m.IncidentDetail),
        canActivate: [permissionGuard],
        data: { permissions: ['incidents.view'] },
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
