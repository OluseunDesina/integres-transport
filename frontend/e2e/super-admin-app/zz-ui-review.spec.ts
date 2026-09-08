import { expect, type Page } from '@playwright/test';

import { captureUiReview } from '../ui-review-capture';

const FIXTURE_BUSINESS = 'Integra E2E KYB Review Business';

/**
 * Walks to a business-scoped screen.
 *
 * These three live at `/businesses/:id/…` and no flat path list can
 * reach them — the same wall slice 5 added `flows` for. Searching by
 * name rather than taking the first row, because this dev database's
 * business list is long and unordered from a reviewer's point of view.
 */
function openBusinessScreen(action: string) {
  return async (page: Page): Promise<void> => {
    await page.goto('/businesses');
    await page.getByRole('searchbox').fill(FIXTURE_BUSINESS);
    const row = page.getByRole('row', { name: new RegExp(FIXTURE_BUSINESS) }).first();
    await expect(row).toBeVisible();
    await row.getByRole('link', { name: action }).click();
  };
}

// Skipped unless UI_REVIEW_DIR is set — see ../ui-review-capture.ts.
captureUiReview({
  email: 'e2e-platform-staff@example.com',
  screens: [
    ['login', '/login'],
    ['home', '/home'],
    ['kyc-queue', '/kyc-queue'],
    ['kyb-queue', '/kyb-queue'],
    ['businesses', '/businesses'],
    // Added in slice 6a: this screen had never been photographed.
    ['client-invite', '/invite-client'],
  ],
  flows: [
    { name: 'paystack-config', walk: openBusinessScreen('Paystack') },
    { name: 'settlement-runs', walk: openBusinessScreen('Settlements') },
    { name: 'seat-hold', walk: openBusinessScreen('Seat hold') },
  ],
});
