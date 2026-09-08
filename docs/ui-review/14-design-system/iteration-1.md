# Spec 14 Slice 1 — visual review, iteration 1

Captured 2026-08-30 via `e2e/ui-review-capture.ts`
(`UI_REVIEW_DIR=… npx playwright test --project=<app> --grep @ui-review`),
at 390 / 768 / 1200 across all four apps.

- **Before:** `baseline/` — 63 screenshots, captured *before* any edit.
- **After:** `iteration-1/` — same screens, same widths, same harness.

The harness is committed rather than ad-hoc so "before" and "after" are
captured identically; that is what makes this a comparison rather than an
impression.

## Intended changes, confirmed

1. **Primary actions are Transit Blue.** `#0F172A`-ish near-black →
   `#2549EB`. Verified in the browser as `rgb(37, 73, 235)` on the
   rendered button, not merely as a token value. This is the identity
   landing, and the only deliberate colour change in the slice.
2. **Control borders are now visible.** The clearest diff in the whole
   set is `route-form-1200`: input outlines go from barely-there to
   plainly legible. This is not a style preference — the old
   `slate-300` measured **1.48:1** against white, and WCAG 1.4.11
   requires **3:1** for a boundary that identifies a control. The new
   token measures **4.76:1**.
3. **Inter is loading**, self-hosted, latin subsets only. Confirmed from
   the computed `font-family` on `body`, and from four `@font-face`
   blocks plus latin `woff2`/`woff` assets in the build output.
4. **Status tones, surfaces and text strengths are unchanged in
   appearance** — the retokening was deliberately meaning-preserving
   everywhere the colour carries meaning, so nothing else moved.

## Findings

### F1 — Pre-existing: passenger nav collapses at 390px

`customer-app/my-bookings-390.png`. The nav links wrap and overlap —
"Tap & Go" sits on top of "Sign out", "Journeys" is jammed against it —
and the header forces horizontal overflow.

**Identical in `baseline/`**, so not introduced here. Already recorded in
`docs/ui-review/10-booking-modes/iteration-1.md` and owned by
`docs/specs/21-passenger-experience.md`, which fixes it with a bottom tab
bar. **Not fixed in this slice**; recorded again because it appears in
every customer-app capture and will keep doing so until that spec lands.

### F2 — Pre-existing: passenger tables overflow horizontally at 390px

Same screenshot: the `TOTAL` column is clipped at the viewport edge.
**Identical in `baseline/`.** A data table is the wrong shape for a
390px consumer screen; the fix belongs with `customer-app`'s own rebuild
slice, not with the token layer. **Not fixed in this slice.**

### F3 — Capture limitation, worth fixing before the next iteration

The `client-admin-app` captures land on whichever Business
`SelectedBusinessStore` auto-selects, and in this dev database that one
has **no routes, trips or bookings** — so `routes`, `trips` and
`bookings` all photograph as empty states. Status pills and the
in-table toggles are therefore **not exercised anywhere in this capture
set**, and their retokening is evidenced only by unit tests.

Not a defect in the UI. The capture list should select a populated
Business before the next iteration so those components are actually
photographed.

## Not findings

- **"Cancel" renders without a border** on `route-form`. Identical in
  the baseline — it is a plain link rather than a `ui-button` secondary,
  and predates this work.

## Verification alongside the visual pass

- 101 `shared-ui` unit tests, 739 across the workspace, four clean
  builds, lint clean on all nine projects.
- Axe: clean throughout. The axe assertions live inside the e2e suites,
  which pass — validator 7/7, customer 11/11, super-admin 16/16,
  client-admin 69 passing with only the two documented known-reds
  (`bookings.spec.ts`'s trip dropdown, `trips.spec.ts`'s date filter,
  both from accumulated fixture data and both red before this slice).

## Next iteration

Nothing in this slice needs a fix, so there is no iteration 2 for it.
F1 and F2 belong to spec 21; F3 is a change to the capture list, to be
made before spec 14's next slice photographs the new primitives.
