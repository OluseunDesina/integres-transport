# Visual iteration — Phase 4 frontend addendum (booking flow)

Two rounds. Iteration 1 captured 36 screenshots (12 states × 390/768/1440px)
across `customer-app`'s trip-search/seat-picker/booking-confirm/my-bookings
and `client-admin-app`'s booking-list. Iteration 2 re-captured after the one
fix below and is what's promoted to `baseline/`.

## Defects found

1. **[Fixed, real] `ui-select`'s native `<select>` had no `w-full`,
   overflowing its container to fit its longest `<option>` content.**
   Live-measured (`scrollWidth`/`clientWidth`, not just judged from the
   screenshot): at the 390px authoritative viewport, the trip-search
   Route picker rendered at 790px inside a 358px container — because this
   session's own extensive e2e test runs had accumulated several
   long-named Routes (`routes.spec.ts`'s own uniquely-suffixed fixture
   names) under the shared e2e Client, and no consumer of `ui-select` had
   previously combined a narrow container with option text that long.
   Fixed in `projects/shared-ui/src/lib/select.ts`: added `w-full` to the
   `<select>`'s class list. Re-verified live (`document.documentElement.scrollWidth`
   now equals `window.innerWidth`, 390 = 390) and via the shared-ui Karma
   suite (39/39 still pass) and the affected e2e specs (booking flow,
   routes, schedules, trips — all pass). This is a shared-component fix,
   so it benefits every `ui-select` consumer app-wide, not just this
   module — same class of root-level fix Phase 3's self-check made for
   `ui-table`'s scroll affordance.

2. **[Investigated, disproved as a false positive — not fixed]
   `document.documentElement.scrollWidth` reported 556px on `my-bookings`
   at 390px**, which the `fullPage: true` screenshot capture reflected as
   visible overflow. Live measurement across the full ancestor chain
   (`getBoundingClientRect()` on every element from the `<table>` up to
   `<html>`) showed every real layout box — including `document.body`
   (`scrollWidth === clientWidth === 390`) and a plain viewport (non-full-page)
   screenshot — is correctly exactly 390px wide, with no visible
   horizontal scrollbar. Only `document.documentElement.scrollWidth`
   (as distinct from `document.body.scrollWidth`) disagreed, a known
   Chromium quirk where a nested `overflow-x-auto` table (the intentional,
   working, Phase-3-fixed scroll-shadow mechanism) is included in
   `documentElement`'s scrollWidth bookkeeping without actually being
   visible or scrollable at the document level. Confirmed via 4 rounds of
   live measurement before concluding this, same "verify before fixing"
   discipline this codebase's own self-check process requires — not
   patched, since there's nothing to patch.

3. **[Investigated, disproved as a false positive — not fixed] An axe
   `color-contrast` violation on the danger confirm button inside
   `ui-confirm-dialog`** (`my-bookings`' cancel dialog), reported by an
   e2e test that checked axe immediately after `toBeVisible()` resolved.
   Live measurement (`getComputedStyle` at increasing waits post-open)
   showed the button is mid-fade during the CDK dialog's entrance
   transition at that instant (translucent background, blended text
   colour) and settles to solid white-on-red — comfortably above the
   4.5:1 WCAG AA threshold — within ~100ms. Fixed the *test* (added a
   200ms wait before the axe check, `e2e/customer-app/booking.spec.ts`),
   not the app.

## What changed

- `projects/shared-ui/src/lib/select.ts` — one class added (`w-full`).

## Still outstanding

- None found in this module specific to the booking flow. The
  pre-existing, already-documented `SelectedBusinessStore`/KYB-queue
  business-accumulation gap (Phase 3's self-check Finding #5) is
  unrelated to this work and untouched here.

Exit criteria met on iteration 2: zero axe violations across every
screen/state captured (once the dialog-timing false positive was
corrected in the test, not the app), no real clipping/overflow at any
viewport, every state renders correctly including the populated
61-booking/60-booking stress case this session's own accumulated test
data produced, unit + e2e + lint + type-check all pass, no regression
from the one real fix. Not the 5-iteration cap — closed on criteria.
