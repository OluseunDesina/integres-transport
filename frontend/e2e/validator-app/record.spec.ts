import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';
const ROUTE_NAME = 'CBD Loop';
const BOARD_STOP = 'Gate A';
const ALIGHT_STOP = 'Gate B';
// Seeded directly by seed_e2e_users (apps/core/management/commands/
// seed_e2e_users.py::_seed_tap_and_go_fixture) — the raw token is never
// persisted by the real issuance flow, so this constant only exists so
// the fixture and this spec agree on the same value.
const TOKEN = 'e2e-tap-credential-fixed-token';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/record$/);
}

function waitForTapPost(page: Page) {
  return page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().includes('/taps/')
  );
}

test.describe('validator-app record-tap', () => {
  test('renders an axe-clean screen with today\'s tap-and-go trip available', async ({
    page,
  }) => {
    await signIn(page);

    const tripOptions = page.getByLabel('Trip').locator('option');
    await expect(tripOptions).toHaveCount(2);
    await expect(tripOptions.nth(1)).toContainText(ROUTE_NAME);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  // Board then alight in one test so the fixture's one-open-journey-
  // per-(business, passenger) invariant is never left open across runs
  // — see this spec file's own note below for the one accepted gap
  // this doesn't cover.
  test('records a board tap then an alight tap, closing the fare journey', async ({ page }) => {
    await signIn(page);

    await page.getByLabel('Trip').selectOption({ index: 1 });
    await expect(page.getByLabel('Stop').locator('option')).toHaveCount(4);

    await page.getByLabel('Tap credential (scan or type)').fill(TOKEN);
    // `exact: true` — "Board"/"Alight" would otherwise also substring-
    // match the submit button's own dynamic label ("Record board tap" /
    // "Record alight tap").
    await expect(page.getByRole('button', { name: 'Board', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await page.getByLabel('Stop').selectOption({ label: BOARD_STOP });

    const [boardResponse] = await Promise.all([
      waitForTapPost(page),
      page.getByRole('button', { name: 'Record board tap' }).click(),
    ]);
    expect(boardResponse.ok()).toBeTruthy();
    await expect(page.getByRole('alert')).toContainText('Recorded. Journey open');
    await expect(page.getByLabel('Tap credential (scan or type)')).toHaveValue('');

    await page.getByRole('button', { name: 'Alight', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Alight', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await page.getByLabel('Tap credential (scan or type)').fill(TOKEN);
    await page.getByLabel('Stop').selectOption({ label: ALIGHT_STOP });

    const [alightResponse] = await Promise.all([
      waitForTapPost(page),
      page.getByRole('button', { name: 'Record alight tap' }).click(),
    ]);
    expect(alightResponse.ok()).toBeTruthy();
    await expect(page.getByRole('alert')).toContainText('Recorded. Journey closed');
    await expect(page.getByRole('alert')).toContainText('300.00');

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  // Not covered here, deliberately: if a previous run of the test above
  // is interrupted between the board and alight steps, the next run's
  // board tap 409s (OpenJourneyExists) — seed_e2e_users has no way to
  // force-close a stray open FareJourney the way it force-resets KYC/
  // KYB status. Accepted, same class of "assumes the previous run
  // finished cleanly" limitation as this codebase's other e2e fixtures.
});
