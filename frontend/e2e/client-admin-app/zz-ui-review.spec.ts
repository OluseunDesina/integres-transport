import { expect, type Page } from '@playwright/test';

import { findTripCarryingPassengers } from '../fixture-lookup';
import { selectBusinessByName } from '../session';
import { captureUiReview } from '../ui-review-capture';

/**
 * The manifest has no URL a capture can reach cold — it needs a real
 * Trip id — and the trips list cannot be trusted to have the right one
 * on its first page, so the trip is resolved through the API the way
 * `booking-tickets` already resolves its Booking.
 */
async function openManifestFor(
  page: Page,
  routeName: string,
  options: { payg?: boolean } = {}
): Promise<void> {
  const token = await page.evaluate(
    () => JSON.parse(localStorage.getItem('integra.auth.session') ?? '{}').accessToken ?? ''
  );
  const trip = await findTripCarryingPassengers(page.request, token, routeName, options);
  await page.goto(`/trips/${trip.id}/manifest`);
  await expect(page.getByRole('heading', { name: 'Trip manifest' })).toBeVisible();
}

// Skipped unless UI_REVIEW_DIR is set — see ../ui-review-capture.ts.
captureUiReview({
  email: 'e2e-client-staff@example.com',
  // Iteration-1's F3: without this the capture landed on a Business with
  // no data, so every list photographed as an empty state.
  activeBusinessName: 'Integra E2E Network Test Business',
  screens: [
    ['login', '/login'],
    // Spec 16 slice 3 replaced `home`'s static link list with the
    // dashboard, at the same path. Renamed here because it is a
    // different screen, not a restyled one — pairing it against the old
    // baseline would compare two unrelated pages.
    ['dashboard', '/home'],
    // The same screen grouped weekly over a wide range, which is the
    // shape the trend charts actually get used in and the only way the
    // week-bucket axis is ever photographed.
    ['dashboard-weekly', '/home?date_from=2026-06-01&date_to=2026-09-05&granularity=week'],
    ['routes', '/routes'],
    ['route-form', '/routes/new'],
    ['trips', '/trips'],
    ['bookings', '/bookings'],
    ['payments', '/payments'],
    // Spec 17 slice 2. The queue photographs its seeded open
    // incident; the detail screen needs a real id, so it is a flow.
    ['incidents', '/incidents'],
    ['incident-form', '/incidents/new'],
    // Spec 16 slice 4's screens. `revenue` is a route; trip performance
    // needs a real trip id, so it is a flow below.
    ['revenue', '/revenue'],
    ['revenue-weekly', '/revenue?date_from=2026-06-01&date_to=2026-09-05&granularity=week'],
    ['staff', '/staff'],
    // Spec 14 slice 2's proof consumers.
    ['vehicles', '/vehicles'],
    ['vehicle-form', '/vehicles/new'],
    // Slice 3a's rebuilt lists.
    ['stops', '/stops'],
    ['vehicle-types', '/vehicle-types'],
    ['drivers', '/drivers'],
    ['schedules', '/schedules'],
    // Slice 3b's.
    ['fares', '/fares'],
    ['tap-go', '/tap-go'],
    ['ledger', '/ledger'],
    ['wallet', '/wallet'],
    ['businesses', '/businesses'],
    // Slice 4's screens. The capture list photographed almost only
    // lists before this; every form in the console was unreviewed.
    ['stop-form', '/stops/new'],
    ['vehicle-type-form', '/vehicle-types/new'],
    ['driver-form', '/drivers/new'],
    ['schedule-form', '/schedules/new'],
    ['trip-form', '/trips/new'],
    ['fare-form', '/fares/new'],
    ['business-form', '/businesses/new'],
    ['white-label', '/white-label'],
    // The route is `/kyc`, not `/kyc-status` — pointed at the latter this
    // captured three blank screenshots and said nothing about it.
    ['kyc-status', '/kyc'],
    // Added in slice 6b, which owns the auth screens. `register` is
    // reachable cold; the two invite-accepts are token-gated and
    // photograph their "invitation unavailable" branch, which is the
    // state a real bad link produces and had never been reviewed.
    ['register', '/register'],
    ['staff-invite', '/staff/invite'],
    ['client-invite-accept', '/register/invite/expired-e2e-review-token'],
    ['staff-invite-accept', '/staff/accept/expired-e2e-review-token'],
    // Spec 18 slice 2. Reachable cold: the screen opens on the passenger
    // lookup with nothing else on it, which is the state worth
    // photographing — everything after it depends on a resolved
    // passenger, and that is the flow below.
    ['counter-booking', '/bookings/counter'],
  ],
  // Spec 15 slice 2. The fare grid needs a route id in its URL, and a
  // *per-segment* Business — under the flat-priced Business the rest of
  // this capture uses, it only ever photographs its "this business
  // prices fares flat" warning. The class selector and its inherited
  // cells are the whole point of the slice, so the walk switches
  // Business and then picks a class.
  flows: [
    {
      // Needs a real incident id, and the queue is the only place one is
      // on screen. **Searched for, not taken off page 1** — spec 17
      // slice 3 added two more sources filing incidents into this same
      // Business, so the seeded fixture is now many pages deep, and
      // this walk failed the whole capture with every later screen
      // unphotographed. The same fix `incidents.spec.ts` already
      // carries.
      name: 'incident-detail',
      walk: async (page) => {
        await page.goto('/incidents');
        await page.getByLabel('Search incidents').fill('INC-E2E001');
        // By role: the active search renders a removable chip carrying
        // the same string, so a bare `getByText` matches two elements.
        await page.getByRole('link', { name: 'INC-E2E001' }).click();
        await page.waitForURL(/\/incidents\/[0-9a-f-]{36}$/);
      },
    },
    {
      // A URL cannot reach this cold — it needs a real Trip id, and the
      // trip list is the only place one is on screen.
      name: 'trip-performance',
      walk: async (page) => {
        await page.goto('/trips');
        await page.locator('tbody tr td a').first().click();
        await page.waitForURL(/\/performance$/);
      },
    },
    {
      // Spec 18 slice 1. Two entries, because `kind` makes them two
      // different tables: a prepaid trip lists tickets and seats, a
      // pay-as-you-go one lists journeys and has no cancelled toggle at
      // all. Photographing only one would leave half the screen
      // unreviewed.
      name: 'trip-manifest-prepaid',
      walk: async (page) => {
        await selectBusinessByName(page, 'Integra E2E Open Seating Business');
        await openManifestFor(page, 'Yaba → Lekki');
      },
    },
    {
      name: 'trip-manifest-pay-as-you-go',
      walk: async (page) => {
        await selectBusinessByName(page, 'Integra E2E Tap & Go Business');
        await openManifestFor(page, 'CBD Loop', { payg: true });
      },
    },
    {
      // Spec 18 slice 2. The screen only reveals the departure, seat and
      // payment sections once a passenger is resolved, so the half that
      // matters cannot be photographed from a URL.
      name: 'counter-booking-filled',
      walk: async (page) => {
        await selectBusinessByName(page, 'Integra E2E Network Test Business');
        await page.goto('/bookings/counter');
        await page.getByLabel('Passenger email').fill('e2e-passenger@example.com');
        await page.getByRole('button', { name: 'Find passenger' }).click();
        await expect(page.getByRole('button', { name: 'Change passenger' })).toBeVisible();
      },
    },
    {
      name: 'fare-matrix-any-class',
      walk: async (page) => {
        await selectBusinessByName(page, 'Integra E2E Per-Segment Fare Business');
        await page.goto('/routes');
        const row = page.getByRole('row', { name: /Apapa → Ojota/ }).first();
        await row.getByRole('button', { name: /^Actions for/ }).click();
        await page.getByRole('menuitem', { name: 'Fares' }).click();
      },
    },
    {
      name: 'fare-matrix-premium',
      walk: async (page) => {
        // Continues from the walk above — already on the grid.
        await page.getByLabel('Service class').selectOption({ label: 'Premium' });
        await page.locator('[aria-busy="true"]').waitFor({ state: 'detached' });
      },
    },
    {
      name: 'route-form-classes',
      walk: async (page) => {
        await selectBusinessByName(page, 'Integra E2E Network Test Business');
        await page.goto('/routes/new');
        await page.getByRole('checkbox', { name: 'Premium' }).check();
      },
    },
  ],
});
