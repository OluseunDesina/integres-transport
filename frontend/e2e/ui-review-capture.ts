import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { selectBusinessByName, signIn } from './session';

/**
 * Shared screenshot capture for the §10.6 visual review loop
 * (docs/specs/14-design-system-and-ui-rebuild.md).
 *
 * Not a test — it asserts nothing about the UI. It exists so "before" and
 * "after" are captured identically, which is what makes the visual pass a
 * comparison rather than an impression.
 *
 * Each app folder has a one-line spec calling `captureUiReview(...)`.
 * They **skip unless `UI_REVIEW_DIR` is set**, so an ordinary suite run
 * never pays for them:
 *
 *   UI_REVIEW_DIR=baseline E2E_SKIP_SEED=1 \
 *     npx playwright test --project=client-admin-app --grep @ui-review
 */

const WIDTHS = [
  { name: '390', width: 390, height: 900 },
  { name: '768', width: 768, height: 1100 },
  { name: '1200', width: 1200, height: 900 },
];

export interface CaptureConfig {
  /** Account used for the signed-in screens. */
  email: string;
  /** `[fileName, routePath]`. `/login` is captured signed-out. */
  screens: [string, string][];
  /**
   * Name of the Business to make active before capturing, for
   * `client-admin-app`.
   *
   * Without it the capture lands on whichever Business
   * `SelectedBusinessStore` happens to auto-select, and in this dev
   * database that one has no routes, trips or vehicles — so every list
   * photographed as an empty state and the components that only appear
   * in a populated row (status pills, action menus) were not in the
   * capture set at all. Recorded as F3 in iteration-1.
   */
  activeBusinessName?: string;
  /**
   * Screens a URL cannot reach, captured by walking to them.
   *
   * The flat `screens` list assumes every screen is a route you can
   * navigate to cold. Three of `customer-app`'s are not: `/search/seats`
   * and `/book` read their subject from router state and bounce back to
   * `/search` when it is absent (`booking-draft.ts`), and
   * `/my-bookings/:id/tickets` needs a real Booking id. Slice 4 hit the
   * same wall on `business-kyb` and `seat-map` and worked around it with
   * a throwaway spec that was then deleted, so the next person needing
   * this had nothing to reuse.
   *
   * Each entry drives the app to the screen and returns; the harness
   * screenshots wherever it ended up. A walk that cannot complete —
   * fixture data missing, say — should throw, for the same reason the
   * `<h1>` check exists: a silently skipped screen is worse than a
   * failed run.
   */
  flows?: { name: string; walk: (page: Page) => Promise<void> }[];
}

export function captureUiReview(config: CaptureConfig): void {
  test('@ui-review capture', async ({ page }, testInfo) => {
    const outDir = process.env['UI_REVIEW_DIR'];
    test.skip(!outDir, 'set UI_REVIEW_DIR to capture (e.g. baseline, iteration-1)');
    // A clean run of the whole list takes ~3 minutes. The headroom is
    // for growth, not for slowness — and it is deliberately not larger:
    // when a walk hangs (a locator waiting for data that never arrives)
    // it burns the entire budget before reporting, so a 30-minute
    // timeout buys nothing and costs half an hour of feedback.
    test.setTimeout(600_000);

    // `UI_REVIEW_SPEC` names the docs/ui-review subfolder, so a later
    // spec's visual pass files under its own heading instead of
    // accumulating inside spec 14's. Defaults to 14 so every existing
    // command keeps working unchanged.
    const specDir = process.env['UI_REVIEW_SPEC'] ?? '14-design-system';
    const dir = join('..', 'docs', 'ui-review', specDir, outDir as string, testInfo.project.name);
    mkdirSync(dir, { recursive: true });

    for (const { name: widthName, width, height } of WIDTHS) {
      await page.setViewportSize({ width, height });
      // Start each width from a clean session so the run is reproducible
      // and /login is genuinely captured signed-out.
      await page.goto('/login');
      await page.evaluate(() => localStorage.clear());

      for (const [name, path] of config.screens) {
        if (path !== '/login') {
          const signedIn = await page.evaluate(
            () => !!localStorage.getItem('integra.auth.session')
          );
          if (!signedIn) {
            await signIn(page, config.email);
            if (config.activeBusinessName) {
              await selectBusinessByName(page, config.activeBusinessName);
            }
          }
        }
        await page.goto(path);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.waitForTimeout(400);

        // A page that rendered nothing at all must fail loudly rather
        // than be written out as a blank PNG. `kyc-status` was captured
        // as three entirely blank images across two iterations of slice
        // 4 while the run reported success — the capture entry pointed
        // at /kyc-status and the route is /kyc, and nothing noticed.
        //
        // A level-1 heading is the check because every screen in every
        // app has exactly one, including the auth pages: if it is
        // missing, either the route did not resolve or the app did not
        // boot, and both make the screenshot worthless.
        await expect(
          page.getByRole('heading', { level: 1 }),
          `${name} (${path}) rendered no <h1> — wrong route, or the app failed to boot`
        ).toBeVisible({ timeout: 5_000 });

        await page.screenshot({ path: join(dir, `${name}-${widthName}.png`), fullPage: true });
      }

      for (const { name, walk } of config.flows ?? []) {
        await walk(page);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.waitForTimeout(400);
        await expect(
          page.getByRole('heading', { level: 1 }),
          `${name} rendered no <h1> at the end of its walk`
        ).toBeVisible({ timeout: 5_000 });
        await page.screenshot({ path: join(dir, `${name}-${widthName}.png`), fullPage: true });
      }
    }

    // A capture run that silently produced nothing would be worse than a
    // failure — the "before" is unrecoverable once the code changes.
    expect(config.screens.length).toBeGreaterThan(0);
  });
}
