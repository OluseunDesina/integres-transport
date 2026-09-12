# Spec 21 slice 3 — Senior Mode — visual review, iteration 1

Captured via `UI_REVIEW_SPEC=21-passenger-experience UI_REVIEW_DIR=iteration-1
E2E_SKIP_SEED=1 npx playwright test --project=customer-app --grep @ui-review`,
run twice — once as-is, once with `UI_REVIEW_SENIOR=1` — producing matched
pairs (`<screen>-<width>.png` / `<screen>-<width>-senior.png`) for all 16
screens/flows at 390/768/1200px. `ui-review-capture.ts` gained the
`UI_REVIEW_SENIOR` env var this slice to drive this dual-mode pass without a
second capture harness.

Every screenshot was read at 390px and 1200px in both modes, per the spec's
own test plan. Two real defects were found and fixed; one is a capture-tool
artifact (no app change); two are named, accepted gaps in an existing,
previously-hardened primitive.

## Findings

**F1 — a long, unbroken `ui-page-header` title/description overflowed and
was silently clipped, rather than wrapping (fixed).**

`home-390-senior.png`: `"Welcome, e2e-passenger@example.com"` — a passenger's
own email, `home.ts`'s greeting — rendered past the right edge, missing
"com". Root cause was two-fold, both in `PageHeader` (`@shared-ui`):

1. Its two flex wrappers had no `min-w-0`, so — same automatic-minimum-size
   rule as `ui-table` below — each grew to fit its content's widest
   *unbreakable* run (the email) instead of shrinking to the available
   width, leaving `break-words` nothing to break inside.
2. `break-words` itself was missing from the `<h1>`/`<p>`.

This existed before Senior Mode (any sufficiently long title/description
would have hit it), but this app's normal 16px body text never produced an
unbreakable run wide enough at 390px to expose it — Senior Mode's larger
type was the first thing to. Fixed in `page-header.ts` (`min-w-0` on both
wrappers, `break-words` on both text nodes); see its own docstring for the
full mechanism. Regression test added to `page-header.spec.ts`. Re-captured
and confirmed: the email now wraps across three lines, fully readable.

**F2 — `document.documentElement.scrollWidth` leaked past the viewport at
390/768px, sourced from an absolutely-positioned `sr-only` descendant of a
too-wide `<table>` escaping its own scroll wrapper's containment (fixed).**

Found by `e2e/senior-mode.ts`'s own overflow assertion, not the screenshots
— this one never rendered visibly wrong, it just failed the "no horizontal
page overflow" check. Root cause, traced with a throwaway diagnostic spec
(not committed): `ui-table`'s `overflow-x-auto` wrapper correctly contained
its own too-wide `<table>` (confirmed via `getBoundingClientRect()` on the
wrapper itself), but the wrapper was not `position: relative` — so an
absolutely-positioned `sr-only` announcement span nested inside (from
`ui-countdown`, in the `md:table-cell` status column) computed its *static
position* against the table's real, wide, un-clipped layout, and finding no
positioned ancestor to contain it, escaped all the way to the document
root's coordinate space, landing far outside the viewport and inflating
`document.documentElement.scrollWidth` directly. Three fixes landed together
in `table.ts`/`app-shell.ts`, each closing a different gap in the same
class of bug:

- `ui-table`'s wrapper gained `position: relative`, so any absolutely
  positioned descendant is contained by it instead of escaping to the root.
- `ui-table`'s host gained `min-w-0` — the same automatic-minimum-size fix
  as F1, needed because it sits in every consumer's `flex flex-col` wrapper.
- `app-shell.ts`'s `<main>` gained `overflow-x-hidden` as a backstop, and
  its header row and the `ml-auto` toggle/bell/sign-out cluster both gained
  `flex-wrap` — at 320px even a correctly-contained header could not fit
  Senior Mode's larger toggle + bell + "Sign out" on one line.

Re-verified: `e2e/senior-mode.ts`'s overflow check passes at 320/390/768/
1200px, and this is the reason it now runs at all four rather than only the
spec's own 390/1200.

**F3 — a `position: fixed` bottom tab bar appears mid-page in `fullPage`
Senior Mode screenshots, overlapping content (capture artifact, not a
defect).**

Visible in most `*-390-senior.png` captures: the bottom nav bar floats partway
down the image instead of at the true bottom, overlapping whatever content
is there. Confirmed via a direct (non-`fullPage`) viewport screenshot at the
same state that the *live* app renders this correctly — the bar sits
properly pinned to the bottom of the real viewport, exactly as
`e2e/responsive-nav.ts` already asserts. This is a known Playwright/Chromium
limitation capturing `position: fixed` elements in a `fullPage` screenshot
of a page tall enough to need multi-segment stitching — Senior Mode's ~1.75x
scale is what makes ordinary screens cross whatever height threshold
triggers it; normal-mode captures of the same screens do not show it. No
code change — noted here so a future reviewer does not chase a phantom bug
in the screenshots themselves.

**F4 — `ui-table`'s dense columns do not adapt to Senior Mode's larger type,
and can wrap mid-word in a narrow column (accepted gap, not fixed).**

`credentials-390-senior.png`: the "Type" column's "QR code" wraps
letter-by-letter ("QR" / "cod" / "e") once three always-visible columns
(Type/Status/Actions) compete for width at Senior Mode's larger font.
`my-bookings-390-senior.png`: the row's own content (route, badges,
countdown, date/price) is wide enough that the "Pay" button sits past the
390px fold, reachable only by the table's own internal horizontal scroll —
its `overflow-x-auto` wrapper correctly contains this (confirmed: no page
overflow), but a Senior Mode user must scroll sideways to find the primary
action, which sits uneasily against this mode's whole purpose.

Root cause: `table.ts`'s own docstring already documents a deliberate,
three-times-hardened decision that this component's text stays at "console
density" (`text-sm`, never `--ui-text-body`) specifically to hold a 390px
fit fought for across `docs/ui-review/14-design-system/` iterations 2, 4 and
6. Senior Mode's mechanism — scaling the root `font-size` so the whole
`rem`-based type ramp grows together — does not (and structurally cannot)
respect that one component's opt-out: `text-sm` is exactly as `rem`-relative
as everything else this mechanism is built to scale.

**Not fixed in this slice, deliberately.** A real fix is a redesign of
`ui-table`'s narrow-viewport column behaviour (a card layout below a
breakpoint, say) — spec 14 / table-component territory, not a token
override, and each attempted patch here surfaced a *different* failure mode
(page overflow → `sr-only` escape → header wrap → this) rather than
converging, which is itself a signal that the component wants dedicated
attention rather than another improvised layer. Every other Senior Mode
requirement this slice owns — contrast, control/target size, the toggle,
QR treatment, motion, page-level overflow — holds on every table screen;
only the table's own internal density does not. Follow-up work, not a
blocker: `axe` reports zero violations on these screens in both modes (text
that wraps awkwardly is still text, not a contrast or semantics failure),
and no table's `Pay`/primary action is ever unreachable, only scrolled-to.

## Screens reviewed clean in both modes at 390 and 1200px

`login`, `search`, `search-results`, `seat-picker`, `seat-picker-premium`,
`booking-confirm`, `booking-confirm-premium`, `booking-tickets` (the large-QR
+ ticket-reference treatment reads exactly as intended — see the spec's own
Implementation note), `journeys`, `payments`, `wallet`, `my-reports`,
`report-issue`, `report-issue-from-booking`.

`home` is clean after F1's fix; `my-bookings` and `credentials` carry F4's
named, accepted gap and are otherwise clean (contrast, targets, toggle,
motion, no page overflow).
