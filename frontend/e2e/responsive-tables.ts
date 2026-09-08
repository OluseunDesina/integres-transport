import { expect, test, type Page } from '@playwright/test';

import { selectBusinessByName, signIn } from './session';

/**
 * The acceptance criterion for `ui-table`'s responsive-column
 * convention, measured in a real browser at real widths.
 *
 * It has to be here rather than in Karma: `hidden md:table-cell` is a
 * media query, and a media query only resolves at a real viewport size.
 * A unit test can prove the *pairing* of classes
 * (`expectColumnVisibilityParity`, `@shared-ui`); only this can prove
 * the result fits.
 *
 * Not a `.spec.ts`, so `playwright.config.ts`'s per-project `testMatch`
 * never picks it up directly — each app folder has a one-line spec that
 * calls `checkResponsiveTables(...)`. Unlike `ui-review-capture.ts`
 * this runs in the ordinary suite: it is a regression guard, not a
 * review aid, and the defect it guards against went unnoticed through
 * three visual reviews.
 *
 * What it asserts, per screen, at each width:
 *
 * 1. The page never scrolls horizontally. A table may scroll inside its
 *    own container; the document may not.
 * 2. Each table fits its container without sideways scroll. This is the
 *    part the tiers exist for.
 * 3. Every row shows exactly as many cells as the header shows columns.
 *    A `<th>` hidden without its `<td>` renders values under the wrong
 *    headings, silently.
 * 4. Any row action control is inside the viewport. The original
 *    finding, stated directly: the row's menu was off-screen.
 */

const WIDTHS = [
  { name: '390', width: 390, height: 900 },
  { name: '768', width: 768, height: 1100 },
  { name: '1200', width: 1200, height: 900 },
];

/** One pixel of slack: `scrollWidth`/`clientWidth` are integers rounded
 * from fractional layout, and a sub-pixel border can read as 1px of
 * overflow on a page that is visually fine. */
const SLACK = 1;

export interface ResponsiveTableConfig {
  email: string;
  /** `[name, routePath]` for every screen that renders a table. */
  /**
   * `[name, path]`, where `path` may be a **function** when the screen
   * has no URL a test can know in advance — `/trips/:id/manifest` needs
   * a real Trip id, and one carrying passengers at that. Without this
   * the one table in the app that most needed measuring was the one
   * table this guard could not reach.
   */
  screens: [string, string | ((page: Page) => Promise<string>)][];
  activeBusinessName?: string;
}

interface TableMeasurement {
  index: number;
  overflow: number;
  headerColumns: number;
  rowCellCounts: number[];
}

async function measure(page: Page): Promise<{
  documentOverflow: number;
  tables: TableMeasurement[];
  actionsOutsideViewport: number;
}> {
  return page.evaluate(() => {
    const visible = (el: Element) => getComputedStyle(el).display !== 'none';

    const tables = Array.from(document.querySelectorAll('table')).map((table, index) => {
      // The scroll container is `ui-table`'s own wrapper; fall back to
      // the parent so this still measures something sane if a table is
      // ever used outside it.
      const wrapper = table.parentElement ?? table;
      const headerColumns = Array.from(table.querySelectorAll('thead > tr > th')).filter(
        visible
      ).length;
      const rowCellCounts = Array.from(table.querySelectorAll('tbody > tr'))
        .map((row) =>
          Array.from(row.children).filter(
            (cell) => (cell.tagName === 'TD' || cell.tagName === 'TH') && visible(cell)
          )
        )
        // A single spanned cell is a message row ("No results"), not a
        // record, and has no columns to line up.
        .filter((cells) => !(cells.length === 1 && cells[0].hasAttribute('colspan')))
        .map((cells) => cells.length);

      return {
        index,
        overflow: table.scrollWidth - wrapper.clientWidth,
        headerColumns,
        rowCellCounts,
      };
    });

    const actionsOutsideViewport = Array.from(
      document.querySelectorAll('tbody button, tbody a')
    ).filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.right > window.innerWidth;
    }).length;

    return {
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      tables,
      actionsOutsideViewport,
    };
  });
}

export function checkResponsiveTables(config: ResponsiveTableConfig): void {
  test.describe('responsive tables', () => {
    for (const { name: widthName, width, height } of WIDTHS) {
      test(`fit the viewport at ${widthName}px`, async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize({ width, height });
        await signIn(page, config.email);
        if (config.activeBusinessName) {
          await selectBusinessByName(page, config.activeBusinessName);
        }

        for (const [name, path] of config.screens) {
          await page.goto(typeof path === 'string' ? path : await path(page));
          await page.waitForLoadState('networkidle').catch(() => undefined);
          await page.waitForTimeout(300);

          const { documentOverflow, tables, actionsOutsideViewport } = await measure(page);

          expect(
            documentOverflow,
            `${name} at ${widthName}px scrolls the page horizontally by ${documentOverflow}px`
          ).toBeLessThanOrEqual(SLACK);

          for (const table of tables) {
            expect(
              table.overflow,
              `${name} at ${widthName}px: table ${table.index} needs ${table.overflow}px of ` +
                `sideways scroll, so part of every row is unreachable without one`
            ).toBeLessThanOrEqual(SLACK);

            for (const [rowIndex, cells] of table.rowCellCounts.entries()) {
              expect(
                cells,
                `${name} at ${widthName}px: table ${table.index} row ${rowIndex} shows ${cells} ` +
                  `cells under ${table.headerColumns} visible headings`
              ).toBe(table.headerColumns);
            }
          }

          expect(
            actionsOutsideViewport,
            `${name} at ${widthName}px leaves ${actionsOutsideViewport} row control(s) off-screen`
          ).toBe(0);
        }
      });
    }
  });
}
