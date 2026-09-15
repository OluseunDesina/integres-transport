import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  // Isolate this test's collapse preference from other e2e specs
  // sharing the same seeded account/browser storage. A one-shot clear
  // here, not `addInitScript` (which would re-run on every reload
  // within a test and wipe out the very preference a test just set).
  await page.evaluate(() => localStorage.removeItem('integra.nav.collapsed'));
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

// The sidebar's width animates on collapse (Tailwind `transition-[width]
// duration-150`) — axe can sample mid-transition and report a
// transient, non-deterministic contrast/layout artifact on a frame no
// human perceives. Same class of flakiness this project's e2e suite has
// hit (and fixed the same way) twice already: kyc-status.spec.ts and
// stops.spec.ts. Wait for the toggle's resulting state, then let the
// ~150ms transition settle before scanning.
async function settleAfterToggle(page: Page): Promise<void> {
  await page.waitForTimeout(200);
}

test.describe('client-admin-app nav collapse', () => {
  test('starts expanded, and the toggle collapses/re-expands it', async ({ page }) => {
    await signIn(page);

    const toggle = page.getByRole('button', { name: 'Toggle navigation width' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('link', { name: 'Businesses' })).toBeVisible();

    await toggle.click();
    await settleAfterToggle(page);

    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Still reachable by accessible name (aria-label) even though the
    // visible text label is gone.
    const businessesLink = page.getByRole('link', { name: 'Businesses' });
    await expect(businessesLink).toBeVisible();
    await businessesLink.click();
    await expect(page).toHaveURL(/\/businesses$/);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('the collapsed preference persists across a reload', async ({ page }) => {
    await signIn(page);

    await page.getByRole('button', { name: 'Toggle navigation width' }).click();
    await settleAfterToggle(page);
    await expect(page.getByRole('button', { name: 'Toggle navigation width' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );

    await page.reload();

    await expect(page.getByRole('button', { name: 'Toggle navigation width' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  });

  test('auto-collapses below the responsive breakpoint regardless of the stored preference', async ({
    page,
  }) => {
    await signIn(page);
    // Explicitly expanded preference — the narrow viewport below should
    // still force the collapsed rail, per the confirmed design.
    await expect(page.getByRole('button', { name: 'Toggle navigation width' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    await page.setViewportSize({ width: 600, height: 800 });
    await settleAfterToggle(page);

    await expect(page.getByRole('button', { name: 'Toggle navigation width' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 720 });
    await settleAfterToggle(page);

    // Reverts to the still-expanded manual preference once widened back.
    await expect(page.getByRole('button', { name: 'Toggle navigation width' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  test('groups related nav items under labeled section headers, hidden when collapsed', async ({
    page,
  }) => {
    await signIn(page);

    // One link from each group, per client-admin-app's own app-shell.ts
    // grouping — confirms the header/item split didn't break routing for
    // any group, not just the first one.
    // `exact: true` throughout — unqualified substring matching collides
    // with other on-page text (e.g. "Operations" also matches inside
    // the "Live operations" nav link and the dashboard's own page-header
    // description), the same class of bug already found once for
    // `getByLabel` on trip-search's Route picker.
    await expect(page.getByText('Network & fleet', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Routes' })).toBeVisible();
    await expect(page.getByText('Operations', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Trips' })).toBeVisible();
    await expect(page.getByText('Finance', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Fares' })).toBeVisible();
    await expect(page.getByText('Admin', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Staff' })).toBeVisible();

    // Collapsed to the icon rail: headers have no room and disappear,
    // same as every item's own text label already does.
    await page.getByRole('button', { name: 'Toggle navigation width' }).click();
    await settleAfterToggle(page);
    await expect(page.getByText('Network & fleet', { exact: true })).toBeHidden();
    // Still reachable by accessible name, same as the existing collapsed
    // assertion above for "Businesses".
    await expect(page.getByRole('link', { name: 'Routes' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('the nav list scrolls independently while the sidebar stays pinned', async ({ page }) => {
    await signIn(page);
    // Short enough that 21 nav items cannot all fit — forces the
    // internal-scroll path this test actually exercises.
    await page.setViewportSize({ width: 1280, height: 500 });

    const nav = page.getByRole('navigation', { name: 'Client Admin primary' });
    // The `min-h-0` fix: without it, `overflow-y-auto` is a no-op and
    // `scrollHeight` never exceeds `clientHeight` no matter how much
    // content is inside.
    const [scrollHeight, clientHeight] = await nav.evaluate((el) => [el.scrollHeight, el.clientHeight]);
    expect(scrollHeight).toBeGreaterThan(clientHeight);

    // Last item is out of view before scrolling the nav list itself...
    const whiteLabel = page.getByRole('link', { name: 'White label' });
    await expect(whiteLabel).not.toBeInViewport();

    await nav.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    // ...and reachable after, with the sidebar itself never having moved
    // (still pinned at the top of the viewport, per `sticky top-0`).
    await expect(whiteLabel).toBeInViewport();
    const aside = page.locator('aside');
    await expect(aside).toHaveCSS('position', 'sticky');
    expect((await aside.boundingBox())?.y).toBe(0);
  });
});
