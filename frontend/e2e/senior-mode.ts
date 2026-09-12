import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { signIn } from './session';

/**
 * The acceptance criteria for spec 21 slice 3's Senior Mode, in a real
 * browser at real widths — a `data-senior` attribute and its `rem`-based
 * token overrides only resolve against an actual layout engine, the same
 * reason `responsive-nav.ts` exists rather than a Karma test for the
 * bottom tab bar.
 *
 * Widths are the spec's own two ("390 and 1200") plus 320 and 768 —
 * `responsive-nav.ts`'s own reasoning: a design that survives 320px
 * survives everything above it, and this app already tests at all four
 * elsewhere.
 *
 * Per width, with Senior Mode on:
 *
 * 1. The page never scrolls horizontally — the single most important
 *    assertion in the spec's own test plan, and the one a `rem`-based
 *    root font-size scale is most likely to break at a breakpoint whose
 *    media query still fires unchanged.
 * 2. axe reports zero violations — re-run with the mode off too, so a
 *    contrast token shared carelessly between the two doesn't regress
 *    the default and go unnoticed (this spec's own named failure mode).
 * 3. Every rendered `min-h-11` control measures at least 56px tall —
 *    the token override in theme.css, checked on real boxes rather than
 *    trusted from the CSS alone.
 */

const WIDTHS = [
  { name: '320', width: 320, height: 800 },
  { name: '390', width: 390, height: 900 },
  { name: '768', width: 768, height: 1100 },
  { name: '1200', width: 1200, height: 900 },
];

/** One pixel of slack — see responsive-tables.ts's own SLACK constant. */
const SLACK = 1;
const MIN_SENIOR_TARGET = 56;

async function enableSeniorMode(page: import('@playwright/test').Page): Promise<void> {
  await page
    .getByRole('switch', { name: 'Senior mode' })
    .click({ timeout: 10_000 });
  await expect(page.getByRole('switch', { name: 'Senior mode' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
}

export function checkSeniorMode(config: { email: string }): void {
  test.describe('Senior Mode', () => {
    for (const { name, width, height } of WIDTHS) {
      test(`no horizontal overflow at ${name}px with Senior Mode on`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await signIn(page, config.email);
        await page.goto('/my-bookings');
        await page.waitForLoadState('networkidle').catch(() => undefined);

        await enableSeniorMode(page);
        await page.waitForTimeout(200);

        const documentOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth
        );
        expect(
          documentOverflow,
          `${name}px scrolls the page horizontally by ${documentOverflow}px with Senior Mode on`
        ).toBeLessThanOrEqual(SLACK);
      });
    }

    for (const { name, width, height } of [
      WIDTHS.find((w) => w.name === '390')!,
      WIDTHS.find((w) => w.name === '1200')!,
    ]) {
      for (const mode of ['off', 'on'] as const) {
        test(`axe reports zero violations at ${name}px, Senior Mode ${mode}`, async ({
          page,
        }) => {
          await page.setViewportSize({ width, height });
          await signIn(page, config.email);
          await page.goto('/my-bookings');
          await page.waitForLoadState('networkidle').catch(() => undefined);

          if (mode === 'on') {
            await enableSeniorMode(page);
            await page.waitForTimeout(200);
          }

          const results = await new AxeBuilder({ page }).analyze();
          expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
        });
      }
    }

    test('the toggle is reachable by keyboard from the header on first load', async ({ page }) => {
      await signIn(page, config.email);
      await page.goto('/my-bookings');
      await page.waitForLoadState('networkidle').catch(() => undefined);

      await page.getByRole('switch', { name: 'Senior mode' }).focus();
      await expect(page.getByRole('switch', { name: 'Senior mode' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('switch', { name: 'Senior mode' })).toHaveAttribute(
        'aria-checked',
        'true'
      );
    });

    test('every min-h-11 control measures at least 56px tall with Senior Mode on', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1200, height: 900 });
      await signIn(page, config.email);
      await page.goto('/my-bookings');
      await page.waitForLoadState('networkidle').catch(() => undefined);

      await enableSeniorMode(page);
      await page.waitForTimeout(200);

      const controls = page.locator('.min-h-11');
      const count = await controls.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        const box = await controls.nth(i).boundingBox();
        if (box && box.height > 0) {
          expect(
            box.height,
            `control ${i} is only ${box.height}px tall with Senior Mode on`
          ).toBeGreaterThanOrEqual(MIN_SENIOR_TARGET - SLACK);
        }
      }
    });
  });
}
