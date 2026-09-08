import AxeBuilder from '@axe-core/playwright';
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

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

async function token(api: APIRequestContext, audience: string, email: string): Promise<string> {
  const response = await api.post(`${BACKEND_URL}/api/v1/auth/${audience}/token/`, {
    data: { email, password: PASSWORD },
  });
  return (await response.json()).access as string;
}

interface SeededTrip {
  id: string;
  serviceDate: string;
  fromStop: string;
  toStop: string;
}

/**
 * A fresh, seat-assigned trip on its own service date.
 *
 * Its own date rather than the shared rolling fixture, because the
 * screen's trip picker filters *by service date* — that is the whole
 * point of it, and it is what keeps this spec from inheriting
 * `booking-list`'s recorded defect where an ascending `limit=100` fetch
 * cannot reach today's departures. A date of its own also means this
 * spec's seat is never the one another spec just took.
 */
async function seedTrip(api: APIRequestContext): Promise<SeededTrip> {
  const staffToken = await token(api, 'client-admin', STAFF_EMAIL);
  const passengerToken = await token(api, 'customer', PASSENGER_EMAIL);

  // Paged lookups, never page 1 plus `.find()`: accumulated e2e data
  // has pushed both of these fixtures off the first page before.
  const route = await findBrowseRouteByName(api, passengerToken, ROUTE_NAME);
  const vehicle = await findVehicleByRegistration(api, staffToken, 'E2E-1234-LA');

  const date = new Date();
  date.setDate(date.getDate() + 2 + Math.floor(Math.random() * 5));
  const serviceDate = date.toISOString().slice(0, 10);

  const trip = await (
    await api.post(`${BACKEND_URL}/api/v1/trips/`, {
      headers: { Authorization: `Bearer ${staffToken}` },
      data: {
        route: route.id,
        service_date: serviceDate,
        departure_time: '09:00:00',
        vehicle: vehicle.id,
      },
    })
  ).json();

  return {
    id: trip.id,
    serviceDate,
    fromStop: route.stops[0].name,
    toStop: route.stops[route.stops.length - 1].name,
  };
}

test.describe('counter booking', () => {
  let trip: SeededTrip;

  test.beforeAll(async () => {
    const api = await request.newContext();
    try {
      trip = await seedTrip(api);
    } finally {
      await api.dispose();
    }
  });

  test('books a seat for a passenger and puts them on the manifest', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);

    await page.goto('/bookings');
    await page.getByRole('link', { name: 'Book for a passenger' }).click();
    await expect(page).toHaveURL(/\/bookings\/counter$/);

    // Step 1 — the passenger. Nothing else is on screen yet.
    await expect(page.getByLabel('Service date')).toHaveCount(0);
    await page.getByLabel('Passenger email').fill(PASSENGER_EMAIL);
    await page.getByRole('button', { name: 'Find passenger' }).click();
    await expect(page.getByRole('button', { name: 'Change passenger' })).toBeVisible();

    // Step 2 — the departure, found by its date rather than by hoping it
    // is on some bounded page.
    await page.getByLabel('Service date').fill(trip.serviceDate);
    await expect(page.getByLabel('Departure')).toBeEnabled();
    await page.getByLabel('Departure').selectOption(trip.id);
    await page.getByLabel('Boarding at').selectOption({ label: trip.fromStop });
    await page.getByLabel('Alighting at').selectOption({ label: trip.toStop });

    // Step 3 — a seat. `toBeVisible`, not `isVisible()`: the chips
    // arrive with the availability response, and only the former
    // retries.
    const seatChips = page.locator('button[aria-pressed]');
    await expect(seatChips.first()).toBeVisible();
    const seatNumber = (await seatChips.first().textContent())?.trim() ?? '';
    // Pinned to *that* seat by name, not to `.first()` of an unpressed
    // set — the set changes the moment one is pressed, so re-resolving
    // it would assert against the next seat along and read as a
    // failure to select.
    const chosenSeat = page.getByRole('button', { name: seatNumber, exact: true });
    await chosenSeat.click();
    await expect(chosenSeat).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Create booking' }).click();

    // The reference the agent reads back to the person standing there.
    const heading = page.getByRole('heading', { name: /BKG-/ });
    await expect(heading).toBeVisible();
    const bookingReference = (await heading.textContent())?.match(/BKG-[0-9A-Z]+/)?.[0] ?? '';
    expect(bookingReference).toMatch(/^BKG-[0-9A-Z]+$/);
    // Nothing was charged: no wallet box was ticked, so the seats are
    // held and the passenger pays from their own app.
    await expect(page.getByText('Nothing has been charged')).toBeVisible();
    await expect(page.getByText('Awaiting payment')).toBeVisible();

    // And the passenger is now on that departure's manifest — the two
    // halves of this spec meeting, and the reason slice 1 shipped a
    // reference at all.
    await page.goto(`/trips/${trip.id}/manifest`);
    await expect(page.getByRole('cell', { name: bookingReference })).toBeVisible();
    await expect(page.getByRole('cell', { name: seatNumber, exact: true })).toBeVisible();
  });

  test('says so plainly when nobody uses that email address', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.goto('/bookings/counter');

    await page.getByLabel('Passenger email').fill('nobody-at-all@example.com');
    await page.getByRole('button', { name: 'Find passenger' }).click();

    // An answer, not a failure: the agent's next move is to ask the
    // person to register, which the message says.
    await expect(page.getByText(/need to register/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change passenger' })).toHaveCount(0);
  });

  test('has no accessibility violations', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.goto('/bookings/counter');
    await page.getByLabel('Passenger email').fill(PASSENGER_EMAIL);
    await page.getByRole('button', { name: 'Find passenger' }).click();
    await expect(page.getByRole('button', { name: 'Change passenger' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
