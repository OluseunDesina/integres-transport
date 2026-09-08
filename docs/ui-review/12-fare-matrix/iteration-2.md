# 12-Fare-Matrix — visual iteration 2

Screen: `client-admin-app` `fares/fare-matrix/:routeId`.

Iteration 1's four fixes applied, then re-captured — this time
including the **interaction states**, which are where the screen
actually earns its keep: dirty tracking, an invalid cell, a completed
save, the clear-a-fare confirm, plus the two variant states and the
entry point.

Captured into `iteration-2/`. Authoritative viewport: **1440**.

## Exit criteria met

All four iteration-1 defects are gone, and the new states hold up:

- `iteration-2/grid-1440.png` — unpriced cells now read as inputs;
  `NGN` sits in the corner header; the heading is one line with the
  route name beneath it.
- `iteration-2/dirty-and-invalid.png` — two edited cells in amber, one
  zero-valued cell in red with `aria-invalid`, save blocked, and the
  live region explaining why.
- `iteration-2/saved.png` — "Saved 3 fares.", amounts re-read from the
  server in its own `450.00` formatting, highlighting cleared.
- `iteration-2/confirm-clear.png` — clearing two priced cells names
  both segments in the dialog before doing anything.
- `iteration-2/flat-mode-1440.png` — amber notice, link to the business
  settings, cells disabled but still showing their prices, no save
  button.
- `iteration-2/no-stops-1440.png` — empty state pointing at the route's
  stop editor.
- `iteration-2/route-list-entry-1440.png` — the per-row "Fares" link.

Stopping here: no defect above cosmetic remained, well inside the
five-iteration cap.

## Defect found in iteration 2

| # | Severity | Defect | Evidence |
|---|---|---|---|
| 5 | Low | "1 cell **need** a fare greater than zero." — the pluraliser switched the noun but not the verb | `iteration-2/dirty-and-invalid.png` |

Fixed, and locked in by a component test asserting the exact singular
string rather than a substring, since the substring version is what let
it through.

## Accessibility

`@axe-core/playwright`, WCAG 2.0/2.1 A + AA, against the live screen:

| State | 390 | 1440 |
|---|---|---|
| Loaded grid | 0 | 0 |
| Dirty + invalid cells | 0 | 0 |
| Flat-mode (disabled) | — | 0 |
| No-stops empty state | — | 0 |
| Confirm dialog open | — | 0 |
| Business form (new select) | — | 0 |

Two apparent findings during this pass turned out to be measurement
artifacts, not defects, and are recorded because the first reading was
wrong:

1. **A `color-contrast` violation on the dialog's danger button**
   (3.65:1, foreground read as `#d5d5d5`). That is the CDK dialog's
   enter animation caught mid-fade. Re-measured after it settles: white
   on `red-700`, **0 violations**.
2. **"business-form did not prefill the live pricing mode"** — the
   harness read the select before the awaited `findById` resolved. With
   a proper wait it reads `per_segment` correctly.

Beyond axe, verified by driving the real browser:

- **Every cell has an accessible name naming both stops** — "Ikeja to
  Lekki fare". Locked in by a component test, because a grid of
  unlabelled inputs is this screen's single biggest a11y risk and a
  reviewer will not re-check 45 of them.
- **Row and column headers carry `scope`**, and the first/last stop are
  correctly excluded from the axes they do not head.
- **Arrow-key navigation walks a column**: focusing `Oshodi to Lekki
  Phase 1` and pressing ArrowDown four times walked exactly
  Mushin → Yaba Terminal → Costain → Marina; five ArrowUps stopped at
  the top rather than wrapping. Cells are `inputmode="decimal"`, not
  `type="number"`, specifically so these keys are free — a number input
  would spin the value instead. Left/right stay with the text caret;
  Tab walks the row.
- **The change count is an `aria-live="polite"` region**, so a
  screen-reader user editing deep in the grid hears it without leaving
  the cell.
