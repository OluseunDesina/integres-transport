# 12-Fare-Matrix — visual iteration 1

Screen: `client-admin-app` `fares/fare-matrix/:routeId` (new).

Captured the loaded grid at 390 / 768 / 1440 into `iteration-1/`.
Authoritative viewport: **1440**. Every image was opened and judged,
not reasoned about from markup.

## Fixture

A 3-stop route is a 2×2 grid and exercises none of the layout risk this
screen carries, so a **6-stop route** (`Fare Grid Check — Oshodi to
Lekki`, 15 forward pairs) was created under the e2e Business, which was
switched to `per_segment` for the run and switched back afterwards.

## Defects

| # | Viewport | Severity | Defect | Evidence |
|---|---|---|---|---|
| 1 | all | Medium | Unpriced cells read as ghost boxes — `border-slate-200` on white is fainter than every other input in the app | `iteration-1/grid-1440.png` |
| 2 | all | Medium | No currency visible anywhere near the cells; the only mention was one line of status text below the table | `iteration-1/grid-1440.png` |
| 3 | all | Low | The inert backward-pair "—" at `text-slate-300` on `bg-slate-50` was effectively invisible | `iteration-1/grid-1440.png` |
| 4 | all | Low | Heading read "Fare grid — Fare Grid Check — Oshodi to Lekki": two different dashes, because the route name carries its own | `iteration-1/grid-1440.png` |

### 1 — Unpriced cells too faint (Medium)

Every cell on an unpriced route is empty, so the border is the only
thing saying "this is editable". At `slate-200` the grid read as a
scattering of ghost rectangles rather than a table you type into.
Raised to `slate-300`, matching `ui-text-field` and `ui-select`.

### 2 — Currency not visible in the grid (Medium)

The amounts are bare numbers. The screen knew the currency (it comes
back on the matrix payload) but only said so in a sentence under the
table, far from the cells and easy to miss when scrolled.

Fixed by putting it in the **corner header cell** — the conventional
place for a matrix's unit. It is stated once rather than as an
adornment repeated 15 (or 45) times, and because that cell is
`sticky left-0` it stays on screen while a wide grid scrolls.

### 3 — Inert cell marker invisible (Low)

`text-slate-300` on `bg-slate-50` is roughly 1.4:1. Not an
accessibility failure — the glyph is `aria-hidden`, and the cell is
correctly announced by its row and column headers — but it failed at
its actual job of showing the triangle's shape at a glance. Now
`slate-400` and centred.

### 4 — Double-dashed heading (Low)

Route names in this database routinely carry their own separators
("Ikeja → CMS", "Lagos - Abeokuta"), so appending the name to the
heading after an em dash produced headings with two different dashes.
The route name is now its own line under the heading.

## What was checked and found correct

- **The triangle is right.** Row *n* has *n* inert cells; the first
  stop heads no column and the last heads no row. Verified by eye
  against the rendered grid, not just the loop bounds.
- **The page never scrolls sideways.** At 390 the grid scrolls inside
  its own container and the sticky row-header column stays put.

## Not fixed

- **No scroll affordance at narrow widths.** At 390 the only cue that
  the grid continues past the right edge is the clipped column. A
  gradient or shadow overlay would be clearer; a clipped column is a
  well-understood cue and the added complexity was not judged worth it.
  Noted rather than fixed.
