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
    await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();
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
    await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 720 });
    await settleAfterToggle(page);

    // Reverts to the still-expanded manual preference once widened back.
    await expect(page.getByRole('button', { name: 'Toggle navigation width' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });
});
