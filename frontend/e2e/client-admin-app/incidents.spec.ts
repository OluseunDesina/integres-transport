import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';
const NETWORK_BUSINESS = 'Integra E2E Network Test Business';

/** Seeded by `seed_e2e_users._seed_incident_fixture` with a fixed
 * reference — `create_incident` generates a random one by design, so a
 * spec could not otherwise name the row it means. */
const SEEDED_REFERENCE = 'INC-E2E001';

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function selectActiveBusiness(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(EMAIL) }).click();
  await page.getByRole('menuitemradio', { name }).click();
}

/**
 * Narrows the queue to the seeded fixture before looking for it.
 *
 * Not `page.goto('/incidents')` and trust page 1. This dev/CI database
 * accumulates incidents from every run — spec 17 slice 3 added two more
 * sources, `validator-app`'s report screen and `customer-app`'s, and
 * both file into this same Business — so the seeded row, which is one of
 * the oldest, sits well past the first page of a `-created_at` list.
 * Exactly the "never trust page 1 of a list this database keeps
 * growing" lesson `fixture-lookup.ts` and `session.ts` already carry.
 */
function seededRowLink(page: Page) {
  // By role, not by text. The active search renders a removable chip
  // reading "Search: INC-E2E001", so a bare `getByText` matches the
  // chip as well as the row and fails strict mode.
  return page.getByRole('link', { name: SEEDED_REFERENCE });
}

async function findSeededIncident(page: Page): Promise<void> {
  await page.goto('/incidents');
  await page.getByLabel('Search incidents').fill(SEEDED_REFERENCE);
  await expect(seededRowLink(page)).toBeVisible();
}

async function openRowMenu(page: Page, rowName: string): Promise<void> {
  await page
    .getByRole('row', { name: new RegExp(rowName) })
    .getByRole('button', { name: new RegExp('^Actions for') })
    .click();
}

async function expectAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

test.describe('client-admin-app incidents', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
  });

  test('renders an axe-clean queue behind the nav shell', async ({ page }) => {
    await findSeededIncident(page);

    await expect(page.getByRole('heading', { name: 'Incidents' })).toBeVisible();
    await expectAxeClean(page);
  });

  test('says on screen that it is showing open incidents only', async ({ page }) => {
    // The narrowing is the default; a queue that hides rows with nothing
    // saying so is indistinguishable from a queue with no data.
    await page.goto('/incidents');

    await expect(page.getByText('Open only')).toBeVisible();
  });

  test('rejects an empty incident visibly and stays axe-clean', async ({ page }) => {
    await page.goto('/incidents/new');
    await page.getByRole('button', { name: 'Report incident' }).click();

    // A rendered message, not merely an absent request — `ui-text-field`
    // shows nothing unless the form binds both [invalid] and
    // [errorMessage], and that is how a previous form shipped broken.
    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page).toHaveURL(/\/incidents\/new$/);
    await expectAxeClean(page);
  });

  test('files an incident and lands on its detail screen', async ({ page }) => {
    const title = `Broken reader ${uniqueSuffix()}`;
    await page.goto('/incidents/new');
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Description').fill('No lights when a card is presented.');
    await page.getByRole('button', { name: 'Report incident' }).click();

    await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    // The detail header renders it as "Reference INC-…", so the
    // reference is not at the start of its own text node.
    await expect(page.getByText(/Reference INC-[0-9A-Z]{6}/)).toBeVisible();
    await expectAxeClean(page);
  });

  test('moves an incident on from the row menu without opening it', async ({ page }) => {
    const title = `Triage me ${uniqueSuffix()}`;
    await page.goto('/incidents/new');
    await page.getByLabel('Title').fill(title);
    await page.getByRole('button', { name: 'Report incident' }).click();
    await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]{36}$/);

    await page.goto('/incidents');
    await openRowMenu(page, title);
    await page.getByRole('menuitem', { name: 'Acknowledge' }).click();

    await expect(
      page.getByRole('row', { name: new RegExp(title) }).getByText('Acknowledged')
    ).toBeVisible();
    await expectAxeClean(page);
  });

  test('grows the history as an incident is worked, and reopens it', async ({ page }) => {
    const title = `Full lifecycle ${uniqueSuffix()}`;
    await page.goto('/incidents/new');
    await page.getByLabel('Title').fill(title);
    await page.getByRole('button', { name: 'Report incident' }).click();
    await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]{36}$/);

    await page.getByLabel('Action').selectOption('acknowledged');
    await page.getByLabel('Note on this change').fill('Seen by ops.');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('Open → Acknowledged')).toBeVisible();
    await expect(page.getByText('Seen by ops.')).toBeVisible();

    await page.getByLabel('Action').selectOption('resolved');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('Acknowledged → Resolved')).toBeVisible();

    // A fault reported fixed and still broken is the normal case.
    await page.getByLabel('Action').selectOption('investigating');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('Resolved → Investigating')).toBeVisible();

    await expectAxeClean(page);
  });

  test('records an internal note against the incident', async ({ page }) => {
    const title = `Note target ${uniqueSuffix()}`;
    await page.goto('/incidents/new');
    await page.getByLabel('Title').fill(title);
    await page.getByRole('button', { name: 'Report incident' }).click();
    await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]{36}$/);

    await page.getByLabel('Internal note').fill('Technician dispatched.');
    await page.getByRole('button', { name: 'Add note' }).click();

    await expect(page.getByText('Technician dispatched.')).toBeVisible();
  });

  test('offers an assignee picker to a user who can manage incidents', async ({ page }) => {
    // The whole reason `GET /incidents/assignable-users/` exists —
    // `/staff/` is gated on an Owner-only codename.
    await findSeededIncident(page);
    await seededRowLink(page).click();

    await expect(page.getByLabel('Assign to')).toBeVisible();
    await expect(page.getByLabel('Assign to').getByRole('option')).not.toHaveCount(1);
  });

  test('links through from the dashboard stat', async ({ page }) => {
    await page.goto('/home');

    await expect(page.getByText('Open incidents')).toBeVisible();
    await page.getByRole('link', { name: 'All incidents' }).click();

    await expect(page).toHaveURL(/\/incidents$/);
  });
});
