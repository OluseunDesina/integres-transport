import AxeBuilder from '@axe-core/playwright';
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

import { findVehicleByRegistration } from '../fixture-lookup';

const STAFF_EMAIL = 'e2e-client-staff@example.com';
const PASSENGER_EMAIL = 'e2e-passenger@example.com';
const PASSWORD = 'e2e-test-password-123';
const PER_SEGMENT_BUSINESS = 'Integra E2E Per-Segment Fare Business';
const ROUTE_NAME = 'Apapa → Ojota';
const REGISTRATION = 'E2E-9012-LA';
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

async function tokenFor(
  api: APIRequestContext,
  audience: 'client-admin' | 'customer',
  email: string
): Promise<string> {
  const response = await api.post(`${BACKEND_URL}/api/v1/auth/${audience}/token/`, {
    data: { email, password: PASSWORD },
  });
  return (await response.json()).access as string;
}

interface Stop {
  id: string;
  name: string;
}

/** Pages `GET /routes/` for the fixture route rather than trusting one
 * bounded page — this dev/CI database accumulates hundreds of e2e
 * routes, and the endpoint has no name filter. Same reasoning as
 * `fixture-lookup.ts`. */
async function findFixtureRoute(
  api: APIRequestContext,
  token: string
): Promise<{ id: string; stops: Stop[] }> {
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await (
      await api.get(`${BACKEND_URL}/api/v1/routes/?limit=${limit}&offset=${offset}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    const match = page.results.find((route: { name: string }) => route.name === ROUTE_NAME);
    if (match) {
      return match;
    }
    if (offset + limit >= page.count) {
      throw new Error(`Fixture route ${ROUTE_NAME} not found — is seed_e2e_users up to date?`);
    }
  }
}

/**
 * The one test that proves the grid, `get_fare()` and booking agree —
 * docs/specs/12-fare-matrix.md's own e2e requirement.
 *
 * The pricing half runs through the real UI, because the grid is what
 * is under test. The booking half runs against the API, matching
 * `bookings.spec.ts`'s established split: the passenger booking flow
 * already has its own end-to-end coverage in the customer-app project,
 * and driving a second app's UI from this project would couple two
 * Playwright projects that are deliberately run separately.
 */
test.describe('client-admin-app fare matrix', () => {
  test('prices a route through the grid, and a booking is charged that price', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, PER_SEGMENT_BUSINESS);
    await page.getByRole('link', { name: 'Routes' }).click();

    const row = page.getByRole('row', { name: new RegExp(ROUTE_NAME) }).first();
    await expect(row).toBeVisible();
    await row.getByRole('link', { name: 'Fares' }).click();
    await expect(page).toHaveURL(/\/fares\/fare-matrix\//);

    await expect(page.getByRole('heading', { name: 'Fare grid' })).toBeVisible();
    // `exact`, because the table's own screen-reader caption names the
    // route too — the accessible name is not an accident here.
    await expect(page.getByText(ROUTE_NAME, { exact: true })).toBeVisible();

    // Backward pairs are not offered at all — only a forward journey
    // can be booked, so only a forward journey can be priced.
    await expect(page.getByLabel('Ojota to Apapa fare')).toHaveCount(0);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    // A price this route does not already carry, so a pass cannot be
    // satisfied by a previous run's fares still sitting in the grid —
    // and so all three cells really are dirty, which the count below
    // asserts. Read rather than randomised: a random amount can collide
    // with the last run's, and the resulting flake would look like a
    // dirty-tracking bug rather than a test bug.
    const current = await page.getByLabel('Apapa to Surulere fare').inputValue();
    let amount = 1000 + Math.floor(Math.random() * 8000);
    while (`${amount}.00` === current) {
      amount += 1;
    }

    // Every forward pair, so the route is fully bookable afterwards.
    await page.getByLabel('Apapa to Surulere fare').fill(String(amount));
    await page.getByLabel('Surulere to Ojota fare').fill(String(amount));
    await page.getByLabel('Apapa to Ojota fare').fill(String(amount * 2));
    await expect(page.getByText('3 unsaved changes')).toBeVisible();

    await page.getByRole('button', { name: 'Save fares' }).click();
    await expect(page.getByText(/Saved 3 fares\./)).toBeVisible();
    await expect(page.getByText('No unsaved changes')).toBeVisible();
    // Re-read from the server, formatted as the backend stores it.
    await expect(page.getByLabel('Apapa to Ojota fare')).toHaveValue(`${amount * 2}.00`);

    // Saving again with nothing edited must not be possible — the whole
    // point of dirty tracking is that it does not churn 3 timelines to
    // re-save the same prices.
    await expect(page.getByRole('button', { name: 'Save fares' })).toBeDisabled();

    const api = await request.newContext();
    try {
      const staffToken = await tokenFor(api, 'client-admin', STAFF_EMAIL);
      const passengerToken = await tokenFor(api, 'customer', PASSENGER_EMAIL);
      const route = await findFixtureRoute(api, staffToken);
      const [apapa, surulere] = route.stops;
      const vehicle = await findVehicleByRegistration(api, staffToken, REGISTRATION);

      // A fresh near-term Trip, for the reason bookings.spec.ts gives:
      // the shared fixture's rolling week may already have its seats
      // reserved by earlier runs.
      const serviceDate = new Date();
      serviceDate.setDate(serviceDate.getDate() + 2 + Math.floor(Math.random() * 5));
      const trip = await (
        await api.post(`${BACKEND_URL}/api/v1/trips/`, {
          headers: { Authorization: `Bearer ${staffToken}` },
          data: {
            route: route.id,
            service_date: serviceDate.toISOString().slice(0, 10),
            departure_time: '10:15:00',
            vehicle: vehicle.id,
          },
        })
      ).json();

      // The quote the passenger is shown must already be the grid's price.
      const quote = await (
        await api.get(
          `${BACKEND_URL}/api/v1/trips/${trip.id}/fare/?from_stop=${apapa.id}&to_stop=${surulere.id}`,
          { headers: { Authorization: `Bearer ${passengerToken}` } }
        )
      ).json();
      expect(quote.amount).toBe(`${amount}.00`);

      const availability = await (
        await api.get(
          `${BACKEND_URL}/api/v1/trips/${trip.id}/availability/?from_stop=${apapa.id}&to_stop=${surulere.id}`,
          { headers: { Authorization: `Bearer ${passengerToken}` } }
        )
      ).json();
      const seat = availability.find((entry: { is_available: boolean }) => entry.is_available);

      const booking = await (
        await api.post(`${BACKEND_URL}/api/v1/bookings/`, {
          headers: {
            Authorization: `Bearer ${passengerToken}`,
            'Idempotency-Key': `e2e-fare-matrix-${Date.now()}-${Math.random()}`,
          },
          data: {
            trip: trip.id,
            seats: [{ seat: seat.seat.id, from_stop: apapa.id, to_stop: surulere.id }],
          },
        })
      ).json();

      // The assertion the whole spec exists for: what the operator typed
      // into one grid cell is what the passenger was actually charged.
      expect(booking.total_amount).toBe(`${amount}.00`);
      expect(booking.currency).toBe('NGN');
    } finally {
      await api.dispose();
    }
  });

  test('warns instead of editing when the business prices flat', async ({ page }) => {
    // The shared bookable Business is flat, so its grid must refuse
    // rather than let an operator fill in prices `get_fare()` would
    // never read.
    const api = await request.newContext();
    let routeId: string;
    try {
      const staffToken = await tokenFor(api, 'client-admin', STAFF_EMAIL);
      const limit = 100;
      routeId = await (async () => {
        for (let offset = 0; ; offset += limit) {
          const listing = await (
            await api.get(`${BACKEND_URL}/api/v1/routes/?limit=${limit}&offset=${offset}`, {
              headers: { Authorization: `Bearer ${staffToken}` },
            })
          ).json();
          const match = listing.results.find((r: { name: string }) => r.name === 'Ikeja → CMS');
          if (match) {
            return match.id as string;
          }
          if (offset + limit >= listing.count) {
            throw new Error('Fixture route Ikeja → CMS not found.');
          }
        }
      })();
    } finally {
      await api.dispose();
    }

    await signIn(page);
    await page.goto(`/fares/fare-matrix/${routeId}`);

    await expect(page.getByText(/prices fares flat/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open business settings' })).toBeVisible();
    await expect(page.getByLabel('Ikeja to Yaba fare')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save fares' })).toHaveCount(0);
  });
});
