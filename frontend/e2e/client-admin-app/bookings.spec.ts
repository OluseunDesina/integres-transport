import AxeBuilder from '@axe-core/playwright';
import { expect, request, test, type Page } from '@playwright/test';

import { findBrowseRouteByName, findVehicleByRegistration } from '../fixture-lookup';

const STAFF_EMAIL = 'e2e-client-staff@example.com';
const PASSENGER_EMAIL = 'e2e-passenger@example.com';
const PASSWORD = 'e2e-test-password-123';
const NETWORK_BUSINESS = 'Integra E2E Network Test Business';
const ROUTE_NAME = 'Ikeja → CMS';
const BACKEND_URL = 'http://localhost:8000';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function selectActiveBusiness(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(STAFF_EMAIL) }).click();
  await page.getByRole('menuitemradio', { name }).click();
}

interface SeededBooking {
  id: string;
  tripId: string;
}

// Creates a fresh Trip + Booking directly against the API — this file's
// concern is the client-admin list/filter screen, not the passenger
// booking flow (covered end-to-end in customer-app/booking.spec.ts), so
// driving a full UI booking here would just be slow, redundant setup.
// A fresh Trip (not the shared fixture's rolling week) keeps the
// resulting Booking uniquely identifiable in the filter dropdown across
// repeated runs.
async function seedBooking(): Promise<SeededBooking> {
  const api = await request.newContext();
  try {
    const staffToken = (
      await (
        await api.post(`${BACKEND_URL}/api/v1/auth/client-admin/token/`, {
          data: { email: STAFF_EMAIL, password: PASSWORD },
        })
      ).json()
    ).access as string;
    const passengerToken = (
      await (
        await api.post(`${BACKEND_URL}/api/v1/auth/customer/token/`, {
          data: { email: PASSENGER_EMAIL, password: PASSWORD },
        })
      ).json()
    ).access as string;

    // Paged, not page 1 plus `.find()` — accumulated e2e routes pushed
    // the fixture past the first page, which surfaced as
    // `Cannot read properties of undefined (reading 'stops')` and is the
    // known-red recorded against this spec.
    const route = await findBrowseRouteByName(api, passengerToken, ROUTE_NAME);
    const fromStop = route.stops[0];
    const toStop = route.stops[route.stops.length - 1];

    // Paged, not one bounded `?limit=50` page plus `.find()` — `GET
    // /vehicles/` has no registration filter, and accumulated e2e
    // vehicles pushed the fixture off the first page. Identical fix and
    // reasoning in customer-app/booking.spec.ts.
    const vehicle = await findVehicleByRegistration(api, staffToken, 'E2E-1234-LA');

    // A near-term date, not a far-future one: `loadTripOptions()` fetches
    // only the earliest 100 Trips by `service_date` (unpaginated, by
    // design — see booking-list.ts's own comment), and many e2e sessions'
    // accumulated Trips mean a far-future date can sort past position
    // 100 and simply never appear in the filter dropdown — the same
    // "unpaginated picker vs. accumulated test data" class of issue this
    // codebase already documents for `SelectedBusinessStore`'s Business
    // picker. A date a few days out is virtually always among the
    // earliest, regardless of how much future test data has piled up.
    const serviceDate = new Date();
    serviceDate.setDate(serviceDate.getDate() + 2 + Math.floor(Math.random() * 5));
    const serviceDateIso = serviceDate.toISOString().slice(0, 10);
    const trip = await (
      await api.post(`${BACKEND_URL}/api/v1/trips/`, {
        headers: { Authorization: `Bearer ${staffToken}` },
        data: {
          route: route.id,
          service_date: serviceDateIso,
          departure_time: '09:00:00',
          vehicle: vehicle.id,
        },
      })
    ).json();

    const availability = await (
      await api.get(
        `${BACKEND_URL}/api/v1/trips/${trip.id}/availability/?from_stop=${fromStop.id}&to_stop=${toStop.id}`,
        { headers: { Authorization: `Bearer ${passengerToken}` } }
      )
    ).json();
    // `.seats`, not the response itself — the endpoint returns an
    // envelope as of docs/specs/10-booking-modes.md, so that a
    // vehicle-less trip can be told apart from a sold-out one.
    const seat = availability.seats.find((entry: { is_available: boolean }) => entry.is_available);

    const booking = await (
      await api.post(`${BACKEND_URL}/api/v1/bookings/`, {
        headers: {
          Authorization: `Bearer ${passengerToken}`,
          'Idempotency-Key': `e2e-booking-list-${Date.now()}-${Math.random()}`,
        },
        data: {
          trip: trip.id,
          seats: [{ seat: seat.seat.id, from_stop: fromStop.id, to_stop: toStop.id }],
        },
      })
    ).json();

    return { id: booking.id, tripId: trip.id };
  } finally {
    await api.dispose();
  }
}

test.describe('client-admin-app bookings', () => {
  test('renders an axe-clean bookings screen with no edit or cancel affordance', async ({
    page,
  }) => {
    await seedBooking();

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.getByRole('link', { name: 'Bookings' }).click();

    await expect(page).toHaveURL(/\/bookings$/);
    await expect(page.getByRole('heading', { name: 'Bookings' })).toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(ROUTE_NAME) }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText('Pending payment')).toBeVisible();

    // Staff have ops visibility only — `booking.view` carries no cancel
    // codename. Slice 3b gave the row a menu, but it offers reading and
    // nothing else.
    await row.getByRole('button', { name: new RegExp('^Actions for') }).click();
    await expect(page.getByRole('menuitem')).toHaveText(['View details']);
    await page.keyboard.press('Escape');

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('filters by search and by status', async ({ page }) => {
    // The trip dropdown this test used to drive is gone. It fetched
    // `limit=100` against ascending Trip ordering, so a Business with
    // more than 100 trips was offered its *oldest* hundred and no recent
    // one was selectable — the known-red recorded in
    // docs/self-check-2026-08-26-spec11.md. Server-side search replaces
    // it, which is why this test is green rather than merely different.
    await seedBooking();

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.goto('/bookings');

    await page.getByLabel('Search bookings').fill(ROUTE_NAME);
    const row = page.getByRole('row', { name: new RegExp(ROUTE_NAME) }).first();
    await expect(row).toBeVisible();

    await page.getByLabel('Status', { exact: true }).selectOption({ label: 'Cancelled' });
    await expect(row).not.toBeVisible();

    await page.getByLabel('Status', { exact: true }).selectOption({ label: 'Pending payment' });
    await expect(row).toBeVisible();

    // Clear-all empties search and status together.
    await page.getByRole('button', { name: 'Clear all' }).click();
    await expect(page.getByRole('row', { name: new RegExp(ROUTE_NAME) }).first()).toBeVisible();
  });
});
