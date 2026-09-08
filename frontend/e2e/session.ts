import type { Page } from '@playwright/test';

/**
 * Sign-in and active-Business selection, shared by the harnesses that
 * drive many screens in one run — `ui-review-capture.ts` and
 * `responsive-tables.ts`.
 *
 * Not a `.spec.ts`, so `playwright.config.ts`'s per-project `testMatch`
 * never picks it up as a test file.
 *
 * Extracted rather than copied: `selectBusinessByName` carries a paged
 * lookup and a deliberate throw, and a second harness re-deriving that
 * would be the same "bounded fetch, silent fallback" bug the original
 * comment below already describes.
 */

const PASSWORD = 'e2e-test-password-123';
const SELECTED_BUSINESS_KEY = 'integra.business.selected';
const BACKEND_URL = 'http://localhost:8000';

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 15_000 });
}

/**
 * Makes a named Business active for `client-admin-app`.
 *
 * Set through the store's own localStorage key rather than by driving
 * the header switcher, because at 390px that control is inside the
 * collapsed nav — a harness that depended on it would depend on the
 * very responsive behaviour it exists to exercise.
 *
 * Paged, not one `limit=100` fetch. This dev database holds well over a
 * hundred Businesses of accumulated e2e cruft ordered `-created_at`,
 * and the fixture Business — created long before all of it — sits past
 * the first hundred. A bounded fetch found nothing and silently left
 * the harness on the auto-selected empty Business.
 */
export async function selectBusinessByName(page: Page, name: string): Promise<void> {
  const token = await page.evaluate(
    () => JSON.parse(localStorage.getItem('integra.auth.session') ?? '{}').accessToken ?? ''
  );

  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const response = await page.request.get(
      `${BACKEND_URL}/api/v1/businesses/?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok()) {
      // Throws rather than returns. A silent return leaves the harness
      // on whichever Business was auto-selected and photographs a whole
      // pass of wrong screens that look merely empty — the exact
      // "bounded fetch, silent fallback" failure this function's own
      // docstring exists to prevent, left unguarded in the one branch
      // that needed it most. Found when spec 17's capture produced an
      // empty queue at 1200 while 390 and 768 were correct, and the
      // reason was invisible.
      throw new Error(
        `Listing Businesses failed with ${response.status()} while selecting ` +
          `"${name}". The capture would otherwise have run against the wrong Business.`
      );
    }
    const body = (await response.json()) as {
      count: number;
      results: { id: string; name: string }[];
    };
    const match = body.results.find((business) => business.name === name);
    if (match) {
      await page.evaluate(
        ([key, id]) => localStorage.setItem(key, JSON.stringify(id)),
        [SELECTED_BUSINESS_KEY, match.id] as const
      );
      // `SelectedBusinessStore` reads localStorage once, at construction.
      // Writing the key does nothing to an app already running, so a
      // caller that navigates **in-app** afterwards — clicking a nav
      // link rather than calling `page.goto` — would exercise whichever
      // Business was active before, silently. Every caller happened to
      // use `goto` until spec 16 slice 4's revenue spec clicked the nav
      // link instead and photographed an empty screen.
      await page.reload();
      return;
    }
    if (offset + limit >= body.count || body.results.length === 0) {
      throw new Error(
        `No Business named "${name}". A harness that silently falls back to ` +
          `another Business exercises the wrong screens.`
      );
    }
  }
}
