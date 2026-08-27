import AxeBuilder from '@axe-core/playwright';
import { expect, request, test, type Page } from '@playwright/test';

import { findVehicleByRegistration } from '../fixture-lookup';

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

    const routes = await (
      await api.get(`${BACKEND_URL}/api/v1/routes/browse/`, {
        headers: { Authorization: `Bearer ${passengerToken}` },
      })
    ).json();
    const route = routes.results.find((r: { name: string }) => r.name === ROUTE_NAME);
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
    const seat = availability.find((entry: { is_available: boolean }) => entry.is_available);

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

    // Staff have ops visibility only — booking.view carries no cancel
    // codename, so this table must offer nothing to click on a row.
    await expect(row.getByRole('button')).toHaveCount(0);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('filters by trip and by status', async ({ page }) => {
    const seeded = await seedBooking();

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.goto('/bookings');

    await page.getByLabel('Trip', { exact: true }).selectOption({ value: seeded.tripId });
    const row = page.getByRole('row', { name: new RegExp(ROUTE_NAME) }).first();
    await expect(row).toBeVisible();

    await page.getByLabel('Status').selectOption({ label: 'Cancelled' });
    await expect(row).not.toBeVisible();

    await page.getByLabel('Status').selectOption({ label: 'Pending payment' });
    await expect(row).toBeVisible();

    await page.getByLabel('Trip', { exact: true }).selectOption({ label: 'All trips' });
    await page.getByLabel('Status').selectOption({ label: 'All statuses' });
    await expect(page.getByRole('row', { name: new RegExp(ROUTE_NAME) }).first()).toBeVisible();
  });
});
