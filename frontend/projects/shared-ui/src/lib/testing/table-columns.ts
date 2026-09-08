/**
 * Guard for the responsive-column convention documented on `ui-table`.
 *
 * Hiding a column at a breakpoint means putting the same visibility
 * class on three separate places in a template: the `<th>`, the data
 * `<td>`, and the skeleton `<td>` that stands in while the list loads.
 * Miss one and every cell after it shifts into the wrong column — the
 * page still renders, nothing throws, and the values simply appear
 * under the wrong headings. Across the twenty-four tables in this
 * workspace that is not a mistake anyone catches by reading.
 *
 * This checks the pairing structurally, so it needs no real viewport:
 * media queries never have to resolve for a missing class to be visible
 * as a missing class.
 *
 * Throws rather than asserting through Jasmine, so it stays free of
 * test-framework imports and can live in the shipped library next to
 * the component whose contract it enforces. A throw fails the calling
 * spec with the message below, which names the table, the column index
 * and both signatures.
 */

/**
 * Classes that change whether a cell is displayed. Deliberately a
 * closed list: an unrelated class differing between a `<th>` and its
 * `<td>` (padding, alignment, font weight) is normal and must not fail.
 */
const VISIBILITY_CLASS =
  /^(hidden|(?:sm|md|lg|xl|2xl):(?:hidden|table-cell|block|inline|flex|inline-flex|inline-block))$/;

function visibilitySignature(cell: Element): string {
  return Array.from(cell.classList)
    .filter((name) => VISIBILITY_CLASS.test(name))
    .sort()
    .join(' ');
}

function describeCell(cell: Element): string {
  const signature = visibilitySignature(cell);
  return signature === '' ? '(always visible)' : signature;
}

/**
 * A row rendering a single spanned cell is a message, not a record —
 * "No results", a colspan'd error. It has no columns to align.
 */
function isSpannedRow(cells: Element[]): boolean {
  return cells.length === 1 && cells[0].hasAttribute('colspan');
}

/**
 * Checks every `<table>` under `root`.
 *
 * @param root  Usually `fixture.nativeElement`.
 * @param label Names the screen in the failure message — the fixture
 *              alone cannot say which list it came from.
 */
export function expectColumnVisibilityParity(root: ParentNode, label: string): void {
  const tables = Array.from(root.querySelectorAll('table'));

  if (tables.length === 0) {
    throw new Error(
      `${label}: expectColumnVisibilityParity found no <table>. The fixture ` +
        `rendered no table at all, so this guard silently checked nothing.`,
    );
  }

  for (const table of tables) {
    const headers = Array.from(table.querySelectorAll('thead > tr > th'));
    if (headers.length === 0) {
      throw new Error(`${label}: a <table> has no <thead> row to compare its cells against.`);
    }

    const rows = Array.from(table.querySelectorAll('tbody > tr'));
    for (const [rowIndex, row] of rows.entries()) {
      const cells = Array.from(row.children).filter(
        (child) => child.tagName === 'TD' || child.tagName === 'TH',
      );
      if (isSpannedRow(cells)) {
        continue;
      }

      if (cells.length !== headers.length) {
        throw new Error(
          `${label}: row ${rowIndex} has ${cells.length} cells but the header has ` +
            `${headers.length} columns. A row and its header must agree before their ` +
            `visibility classes can be compared.`,
        );
      }

      for (const [columnIndex, header] of headers.entries()) {
        const cell = cells[columnIndex];
        if (visibilitySignature(header) !== visibilitySignature(cell)) {
          throw new Error(
            `${label}: column ${columnIndex} ("${header.textContent?.trim()}") is ` +
              `${describeCell(header)} in the header but ${describeCell(cell)} in row ` +
              `${rowIndex}. A column hidden in one place and not the other shifts every ` +
              `later cell under the wrong heading.`,
          );
        }
      }
    }
  }
}
