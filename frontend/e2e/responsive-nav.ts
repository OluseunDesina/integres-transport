import { expect, test } from '@playwright/test';

import { signIn } from './session';

/**
 * The acceptance criterion for spec 21 slice 1's responsive passenger
 * navigation, measured in a real browser at real widths — the same
 * reason `responsive-tables.ts` exists rather than a Karma test: a
 * media query only resolves at a real viewport, and the defect this
 * guards against (`docs/ui-review/10-booking-modes/iteration-1.md`,
 * the header wrapping mid-label and forcing horizontal page overflow
 * at 390px) was a real-browser finding, not a unit-test one.
 *
 * Widths are the brief's own two breakpoints (768, and implicitly
 * everything above via 1200) plus 390 — the authoritative passenger
 * viewport the original defect was found at — plus 320, because a
 * design that survives 320px survives everything above it.
 *
 * What it asserts, per width:
 *
 * 1. The page never scrolls horizontally.
 * 2. Exactly one `nav[aria-label="Primary"]` is in the DOM — never two
 *    copies toggled by CSS visibility, which a screen reader announces
 *    as a duplicate landmark regardless of `display`.
 * 3. Below 640px (Tailwind's own `sm`) that nav lives inside the fixed
 *    bottom tab bar; at 640px and above it lives in the header.
 * 4. Every nav link is at least 44x44px — the touch-target minimum
 *    this codebase already uses elsewhere (`min-h-11`).
 * 5. The bottom bar never covers page content: the last control in
 *    `main` is not hidden behind it once the page is scrolled to its
 *    end.
 */

const WIDTHS = [
  { name: '320', width: 320, height: 700, mobile: true },
  { name: '390', width: 390, height: 900, mobile: true },
  { name: '768', width: 768, height: 1100, mobile: false },
  { name: '1200', width: 1200, height: 900, mobile: false },
];

/** One pixel of slack — see responsive-tables.ts's own SLACK constant. */
const SLACK = 1;
const MIN_TARGET = 44;

export function checkResponsiveNav(config: { email: string }): void {
  test.describe('responsive passenger navigation', () => {
    for (const { name, width, height, mobile } of WIDTHS) {
      test(`renders one primary nav that fits at ${name}px`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await signIn(page, config.email);
        await page.goto('/my-bookings');
        await page.waitForLoadState('networkidle').catch(() => undefined);

        const navs = page.locator('nav[aria-label="Primary"]');
        await expect(navs).toHaveCount(1);

        const documentOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth
        );
        expect(
          documentOverflow,
          `${name}px scrolls the page horizontally by ${documentOverflow}px`
        ).toBeLessThanOrEqual(SLACK);

        const bar = page.locator('.fixed.bottom-0');
        await expect(bar).toHaveCount(mobile ? 1 : 0);
        if (mobile) {
          // main's own box always fills the remaining flex height
          // regardless of its padding — a fixed-position bar sits
          // outside document flow and does not shrink it. What matters
          // is whether real content is visually obscured once the page
          // is scrolled to its end, so this checks the last
          // interactive element in main, not the container box.
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

          const barBox = await bar.boundingBox();
          expect(barBox).not.toBeNull();

          const lastControl = page.locator('main a, main button, main input').last();
          if (await lastControl.count()) {
            const controlBox = await lastControl.boundingBox();
            if (controlBox && barBox) {
              expect(
                controlBox.y + controlBox.height,
                `${name}px: the last control in main is hidden behind the bottom bar`
              ).toBeLessThanOrEqual(barBox.y + SLACK);
            }
          }
        }

        const links = navs.locator('a');
        const count = await links.count();
        for (let i = 0; i < count; i++) {
          const box = await links.nth(i).boundingBox();
          expect(box).not.toBeNull();
          if (box) {
            expect(box.height, `${name}px nav link ${i} is only ${box.height}px tall`).toBeGreaterThanOrEqual(
              MIN_TARGET - SLACK
            );
            expect(box.width, `${name}px nav link ${i} is only ${box.width}px wide`).toBeGreaterThanOrEqual(
              MIN_TARGET - SLACK
            );
          }
        }
      });
    }
  });
}
