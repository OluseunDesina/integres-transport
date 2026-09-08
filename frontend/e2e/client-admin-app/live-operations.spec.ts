import { execSync } from 'node:child_process';

import AxeBuilder from '@axe-core/playwright';
import { expect, request, test, type Page } from '@playwright/test';

import { findBrowseRouteByName, findVehicleByRegistration } from '../fixture-lookup';

const STAFF_EMAIL = 'e2e-client-staff@example.com';
const PASSENGER_EMAIL = 'e2e-passenger@example.com';
const PASSWORD = 'e2e-test-password-123';
const BACKEND_URL = 'http://localhost:8000';

// `seed_e2e_users`' only coordinated route (real `Stop.latitude`/
// `longitude`) — see that command's own comment on
// `OPEN_SEATING_STOP_COORDINATES`. Every other fixture route has
// `None` for both, which `simulate_vehicle_positions` and the
// progress/ETA computation both skip by design.
const ROUTE_NAME = 'Yaba → Lekki';
const VEHICLE_REGISTRATION = 'E2E-3456-LA';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function expectAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

/**
 * A fresh in-progress Trip on the fixture's one coordinated route,
 * scheduled close to "now" — not one of `seed_e2e_users`' own rolling
 * week of departures. Two reasons, not one:
 *
 * 1. That rolling week's *next* departure already carries the
 *    boardable open-seating ticket `_seed_boardable_open_seating_ticket`
 *    seeds (validator-app's own e2e fixture) — moving it to
 *    `in_progress` here would pull it out from under that spec.
 * 2. `punctuality.delay_minutes` reads however many days old a shared
 *    fixture happens to be once transitioned; a trip scheduled for "now"
 *    reads sanely instead.
 *
 * A fresh Trip per run does mean one accumulates in the fixture
 * database each time this spec executes — the same accepted tradeoff
 * `bookings.spec.ts`'s own `seedBooking()` names for the same reason.
 */
async function seedInProgressTrip(): Promise<void> {
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

    const route = await findBrowseRouteByName(api, passengerToken, ROUTE_NAME);
    const vehicle = await findVehicleByRegistration(api, staffToken, VEHICLE_REGISTRATION);

    const now = new Date();
    const trip = await (
      await api.post(`${BACKEND_URL}/api/v1/trips/`, {
        headers: { Authorization: `Bearer ${staffToken}` },
        data: {
          route: route.id,
          service_date: now.toISOString().slice(0, 10),
          departure_time: now.toISOString().slice(11, 19),
          vehicle: vehicle.id,
        },
      })
    ).json();

    await api.post(`${BACKEND_URL}/api/v1/trips/${trip.id}/status/`, {
      headers: { Authorization: `Bearer ${staffToken}` },
      data: { status: 'in_progress', reason: 'live-operations e2e fixture' },
    });
  } finally {
    await api.dispose();
  }
}

/**
 * Drives the real ingest contract exactly as a device would — see
 * `apps.telemetry.management.commands.simulate_vehicle_positions`'s own
 * docstring on why this walks through `record_positions()` rather than
 * writing rows directly. Same `docker compose exec` convention
 * `global-setup.ts` already uses to seed fixtures, and the same escape
 * hatch applies: running the backend outside Docker means there is no
 * container for this to exec into — run the command yourself and
 * comment this call out locally.
 */
function runSimulatorOnce(): void {
  execSync('docker compose exec -T backend python manage.py simulate_vehicle_positions', {
    cwd: '..',
    stdio: 'inherit',
  });
}

test.describe('client-admin-app live operations', () => {
  test('shows the simulated vehicle, its progress, and the simulated-data warning', async ({
    page,
  }) => {
    await seedInProgressTrip();
    runSimulatorOnce();

    await signIn(page);
    await page.goto('/live-operations');
    await expect(page.getByRole('heading', { name: 'Live operations' })).toBeVisible();

    // Not a subtle badge — the spec's own words for why this warning
    // exists at all (docs/specs/20-live-operations.md's "The simulator").
    await expect(
      page.getByText('Some vehicles shown here are simulated positions')
    ).toBeVisible();

    const row = page.getByRole('listitem').filter({ hasText: VEHICLE_REGISTRATION }).first();
    await expect(row).toBeVisible();
    await row.click();

    // The progress line: "N / M stops — Last → Next".
    await expect(page.getByText(/\d+ \/ \d+ stops/)).toBeVisible();
    await expectAxeClean(page);
  });
});
