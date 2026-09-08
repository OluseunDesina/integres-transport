import { execSync } from 'node:child_process';

import AxeBuilder from '@axe-core/playwright';
import { expect, request, test, type Page } from '@playwright/test';

import { findTripCarryingPassengers } from '../fixture-lookup';

const PASSENGER_EMAIL = 'e2e-passenger@example.com';
const STAFF_EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';
const BACKEND_URL = 'http://localhost:8000';

// `seed_e2e_users`' only coordinated route (real `Stop.latitude`/
// `longitude`) — see that command's own `OPEN_SEATING_STOP_COORDINATES`
// comment. It is also the route `_seed_boardable_open_seating_ticket`
// puts a guaranteed **paid** booking on for `e2e-passenger`, which is
// what this spec reuses rather than creating a fresh trip: this test
// needs a trip the *passenger* already holds a ticket on, and that
// fixture is the one deterministic source of that.
const ROUTE_NAME = 'Yaba → Lekki';

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function expectAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

/**
 * Moves the passenger's boardable-ticket fixture trip to `in_progress`
 * — idempotent across repeated runs on the same seeded database.
 * `TripStatusSerializer.validate` treats "transition to the status the
 * trip is already at" as a no-op success rather than an illegal
 * transition, so a second run against a database that was not
 * re-seeded in between (already `in_progress`) succeeds the same way
 * the first one did, with no need to check the current status first.
 */
async function ensureTripInProgress(): Promise<string> {
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

    const trip = await findTripCarryingPassengers(api, passengerToken, ROUTE_NAME);
    await api.post(`${BACKEND_URL}/api/v1/trips/${trip.id}/status/`, {
      headers: { Authorization: `Bearer ${staffToken}` },
      data: { status: 'in_progress', reason: 'e2e passenger tracking fixture' },
    });
    return trip.id;
  } finally {
    await api.dispose();
  }
}

/**
 * Drives the real ingest contract exactly as a device would — see
 * `apps.telemetry.management.commands.simulate_vehicle_positions`'s own
 * docstring. Same `docker compose exec` convention `global-setup.ts`
 * already uses; the same escape hatch applies if the backend runs
 * outside Docker (no container for this to exec into).
 */
function runSimulatorOnce(): void {
  execSync('docker compose exec -T backend python manage.py simulate_vehicle_positions', {
    cwd: '..',
    stdio: 'inherit',
  });
}

test.describe('customer-app trip tracking', () => {
  test('shows the same simulated vehicle a ticket-holder can track', async ({ page }) => {
    await ensureTripInProgress();
    runSimulatorOnce();

    await signIn(page, PASSENGER_EMAIL);
    await page.goto('/my-bookings');

    const row = page
      .locator('tbody tr')
      .filter({ hasText: ROUTE_NAME })
      .filter({ hasText: 'Paid' })
      .first();
    await row.getByRole('button').last().click();
    await page.getByRole('menuitem', { name: 'Track this trip' }).click();

    await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/track$/);
    await expect(page.getByRole('heading', { name: ROUTE_NAME })).toBeVisible();
    // The progress line: "N / M stops — Last → Next".
    await expect(page.getByText(/\d+ \/ \d+ stops/)).toBeVisible();
    await expectAxeClean(page);
  });

  test('reports an unknown trip as not found, not an error', async ({ page }) => {
    // `GET /trips/{id}/live/`'s own edge case: an unheld or nonexistent
    // trip is a 404, never a 403 or a 500 — confirming a trip exists is
    // exactly what a 403 would do, and the tenant-scoped manager makes
    // an unknown id a 404 by construction. A random id stands in for
    // "not held" here rather than a real trip belonging to someone
    // else: `e2e-passenger` is the one fixture passenger every seeded
    // flow shares, so it genuinely holds something on nearly every
    // route this database has — there is no reliably "someone else's"
    // trip to point at instead.
    await signIn(page, PASSENGER_EMAIL);
    await page.goto('/trips/00000000-0000-0000-0000-000000000000/track');

    await expect(page.getByText('Trip not found')).toBeVisible();
    await expectAxeClean(page);
  });
});
