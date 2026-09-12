# 21-Passenger-Experience: Senior Mode, hold countdown, mobile navigation

Ninth and final spec of the Transit OS adoption arc. Entirely
passenger-facing, and the only one whose main deliverable is
accessibility.

## Scope and non-goals

`transit_os_architecture_updated.md` requires a Senior Mode
(double-sized fonts, high contrast, simplified layout, a large QR for
ticket verification), a reservation countdown timer, WCAG 2.1 AA
throughout, and a mobile-first responsive design with breakpoints at
768px and 1200px.

Two of those are outright missing, and one is a standing recorded
defect:

1. **Senior Mode does not exist** in any form.
2. **There is no countdown anywhere.** `Business.seat_hold_minutes` is
   enforced server-side by the expiry sweep, but the passenger is told
   about it in prose — `booking-confirm.html:44` explains the hold in a
   paragraph. There is not one `setInterval` or `interval(` in the
   entire frontend.
3. **The passenger navigation collapses at 390px** — the authoritative
   customer-app viewport. The header is a single flex row of five-plus
   links at `max-w-4xl`; below roughly 500px they wrap and overlap and
   the header forces horizontal page overflow. Recorded in
   `docs/ui-review/10-booking-modes/iteration-1.md`, never fixed, and
   noted there as something that "will keep appearing in every
   customer-app screenshot until someone owns it". Doc 1's mobile-first
   requirement makes it in scope; this spec owns it.

### In scope

- A responsive passenger navigation that works at 320px upward.
- Senior Mode across `customer-app`.
- A reservation hold countdown, backed by a server-supplied expiry.
- A WCAG 2.1 AA sweep of `customer-app` against the documented
  breakpoints.

### Non-goals

- **Not the operator apps.** `client-admin-app`, `super-admin-app` and
  `validator-app` keep their desktop-first layouts and gain no Senior
  Mode. The brief scopes Senior Mode to passengers, and a validator
  handheld has its own ergonomics.
- **No server-synced preference.** Senior Mode is stored per device in
  `localStorage`. A `User` preference column would sync across devices
  and is a reasonable follow-up; it is not built here, because the
  device with the large screen is usually the device that needs the
  setting, and a model change is not worth it for that.
- **No separate "senior" routes, screens or app.** One app, one set of
  components, a display mode. A parallel simplified app is how two
  divergent codebases start.
- **No text-to-speech, voice control or screen-reader-specific UI.**
  Correct semantics and ARIA are the deliverable; assistive technology
  supplies the rest.
- No offline mode for `customer-app` (it is not a PWA; `validator-app`
  is the only installable app here).

## Data model changes

**None.** One serializer addition:

`BookingSerializer` gains `hold_expires_at` and `hold_expires_in_seconds`.

`SeatReservation` already carries the expiry the sweep acts on; the
Booking serializer never exposed it, which is why the UI could only
describe the hold in prose. `hold_expires_at` is the **earliest**
non-released reservation expiry for the booking, and `null` when
nothing is held.

**Both** are returned, deliberately. An absolute timestamp compared
against a wrong device clock produces a countdown that is confidently
incorrect — and phones with bad clocks are common in the target market.
The client counts down from `hold_expires_in_seconds` (server-computed)
and uses `hold_expires_at` only for display.

`hold_expires_at` is `null` for open-seating and quick-book "places"
bookings, because **they hold nothing**. Spec 10 already established
this and `booking-confirm.html` was already corrected once for claiming
otherwise. The countdown must not resurrect that claim; a `null` here
is the mechanism that stops it.

## API surface

**No endpoint is added, removed or re-pathed.** Two response fields are
added to an existing one:

| Method | Path | Permission | Change |
|---|---|---|---|
| `GET` | `/bookings/mine/` | authenticated passenger | `hold_expires_at`, `hold_expires_in_seconds` added to each result |
| `GET` | `/bookings/` | `booking.view` | Same two fields, for consistency of the shared serializer |
| `POST` | `/bookings/` | authenticated passenger | Same two fields on the created booking, so the confirm screen can start counting down without a second request |

Both fields are read-only and computed; neither is accepted on write.
Additive to the OpenAPI schema, so no existing client breaks and
`npm run openapi:check` is the only regeneration needed.

Senior Mode adds no API surface at all — it is a client display mode
with a per-device preference, per the non-goal above.

## Frontend design

### Responsive navigation

Below `sm` (640px, covering the 390px authoritative viewport), the
primary navigation moves to a **fixed bottom tab bar**; at `sm` and
above it stays the current top bar. A bottom bar is the ordinary
consumer-transit pattern, keeps targets within thumb reach, and removes
the overflow at its cause rather than shrinking type until it fits.

- Same `routerLink`s, same `routerLinkActive`, same `aria-current`.
- One `<nav aria-label="Primary">` in the DOM at a time, not two
  visibility-toggled copies — duplicated landmarks are announced twice.
- Minimum 44×44px targets (already the `min-h-11` convention here).
- Bottom inset respects `env(safe-area-inset-bottom)`.
- Page content gains matching bottom padding so the bar never covers
  the last element or a submit button.
- The notification bell stays in the top bar at every size.

Verified at 320, 390, 768 and 1200px — the brief's own breakpoints plus
320px, because a design that survives 320px survives everything above.

### Senior Mode

A display mode, not a theme.

**Mechanism.** `SeniorModeService` (`customer-app`) holds a signal,
persisted to `localStorage` and read once at boot. It sets
`data-senior="true"` on the document root; all styling hangs off that
attribute through CSS custom properties, so no component branches on
the mode in TypeScript and no template gains a second layout.

**What it changes:**

| Aspect | Behaviour |
|---|---|
| Type scale | Root scale roughly doubled via a custom property the type ramp already derives from — not per-component font sizes |
| Contrast | A higher-contrast token set meeting **7:1** body text (AAA), above the AA 4.5:1 baseline the app already meets |
| Layout | Single column throughout; secondary and decorative content hidden; forms one field per row |
| Targets | Minimum 56×56px |
| QR codes | Ticket and credential QRs render substantially larger, with the ticket reference in large text beneath so a conductor can read it if the scan fails |
| Motion | All non-essential transitions removed |

**What it must not do:** fight the platform. Senior Mode is *additive*
to browser zoom and OS text scaling, not a replacement. The app must
already reflow correctly at 200% zoom with Senior Mode **off** (WCAG
1.4.4 / 1.4.10), and turning it on must not introduce horizontal
scrolling at any supported width. Both are asserted.

`prefers-reduced-motion` and `prefers-contrast` are honoured
independently of the toggle — a system preference already expressed
should not require finding a setting in this app.

**Where the toggle lives:** in the header at every viewport, reachable
without navigating into a settings screen. Someone who needs this mode
should not have to read six-point type to find it. It is a `ui-toggle`
with an accessible label, and — per the defect found in spec 10's
visual pass — its explanatory text is linked via `describedBy`, because
`ui-toggle` renders no text of its own and a loose `<p>` beside it
reaches sighted users only.

### Hold countdown

`ui-countdown` is this spec's own component, built to spec 14's tokens
and component conventions. Spec 14 also owns `customer-app`'s consumer
surface profile and its visual rebuild; **this spec owns the mobile
navigation behaviour and its breakpoint tests**, and the two are
coordinated rather than implemented twice — whichever lands first, the
other consumes it.

A `ui-countdown` component in `@shared-ui`, used on `booking-confirm`
and on `my-bookings` rows for `pending_payment` bookings with a hold.

- Driven by `hold_expires_in_seconds`; ticks locally once per second.
- Renders `aria-live="polite"` **at coarse intervals only** — five
  minutes, one minute, thirty seconds — not every second. A per-second
  live region is unusable with a screen reader, and this is the most
  likely way to make this feature actively harmful.
- Under two minutes it changes appearance **and** wording ("expiring
  soon"), never colour alone.
- **On reaching zero it does not assert expiry.** It re-fetches the
  booking and renders whatever the server says. The expiry sweep is a
  periodic job; a client that declares a seat lost the instant its own
  timer hits zero will sometimes be wrong, and telling someone they
  lost a seat they still hold is the worse error.
- Renders nothing at all when `hold_expires_at` is `null`.
- Cleans up its interval on destroy, and pauses while the tab is
  hidden.

### The `computed()` trap

Any value derived from a form control here uses
`toSignal(control.valueChanges)`, never a bare `computed()` over
`control.value` — that depends on no signal and caches its first result
forever. Both validator screens carried exactly that bug for months
with unit tests passing against it, because Karma leaves the computed
dirty and a real browser does not. Every assertion in this spec's test
plan is therefore on **rendered DOM**.

## Edge cases

| Case | Expected behaviour |
|---|---|
| `localStorage` unavailable or blocked | Senior Mode defaults off; the toggle still works for the session; no throw |
| Senior Mode on, viewport 320px | Single column, no horizontal scroll, all targets ≥56px |
| Senior Mode on + browser zoom 200% | Still reflows; no horizontal scroll |
| System `prefers-contrast: more`, mode off | High-contrast tokens applied anyway |
| Open-seating / quick-book booking | `hold_expires_at` null → no countdown, and no claim that places are held |
| Booking already paid | No countdown |
| Hold expires while the screen is open | Re-fetch, then render the server's status |
| Device clock hours wrong | Countdown still correct — it counts from the server-supplied duration |
| Tab hidden for ten minutes | Countdown resyncs from a fresh fetch on return rather than jumping |
| Multiple held bookings in the list | Each row counts down independently; one shared interval drives them |
| Very long route or passenger names in Senior Mode | Wrap, never truncate to ellipsis — a truncated destination is unreadable to exactly the user this mode is for |

## Failure modes

- **A live region that announces every second.** Named above; the
  coarse-interval rule is the mitigation and it is tested.
- **Senior Mode as a second layout.** Prevented structurally: styling
  hangs off one root attribute and CSS custom properties. A component
  that branches on the mode in TypeScript is a review failure, because
  it is the first step toward two divergent UIs where one gets fixed.
- **Contrast regressions elsewhere.** Raising contrast for one mode can
  quietly lower it for the default if tokens are shared carelessly. Axe
  runs against both modes, not just the new one.
- **Leaked intervals.** The countdown is the first timer in this
  codebase. Teardown and hidden-tab pause are asserted; an interval that
  survives navigation is invisible until it is a battery complaint.
- **The bottom bar hiding content.** Matching page padding, tested at
  the smallest supported width against the longest screen — a submit
  button hidden behind a fixed bar is a total failure of the flow it
  sits in.

## Test plan

### Backend

- `hold_expires_at` is the earliest live reservation expiry for the
  booking; `null` when nothing is held.
- `null` for open-seating and quick-book bookings — asserted directly,
  since this is the false claim already fixed once.
- `hold_expires_in_seconds` is server-computed and consistent with
  `hold_expires_at`, and is never negative (floored at zero for an
  expired-but-unswept hold).
- Cross-client isolation is already covered by the booking endpoints
  and is re-asserted for the new fields.

### Frontend

- `SeniorModeService`: persists, restores, survives an unavailable
  `localStorage`, sets and clears the root attribute.
- `ui-countdown`: renders from seconds not timestamps; coarse live-region
  announcements (asserted on `aria-live` content changes, not on every
  tick); the sub-two-minute state changes text as well as style; renders
  nothing on a null expiry; **re-fetches rather than asserting expiry at
  zero**; clears its interval on destroy.
- Navigation: exactly one `nav[aria-label="Primary"]` in the DOM at each
  breakpoint; the same links present in both layouts; `aria-current`
  correct.
- Every assertion on rendered DOM, per the trap above.

### E2E and accessibility

Per-project, `customer-app`, at **320, 390, 768 and 1200px**:

- No horizontal page overflow at any width, mode on or off. This is the
  direct regression test for the recorded 390px defect and is the single
  most important assertion in this spec.
- Axe with zero violations on every customer-app screen, in **both**
  modes, at 390px and 1200px.
- Keyboard-only traversal of search → seat/places → confirm → pay,
  with visible focus throughout and no trap.
- The Senior Mode toggle is reachable by keyboard from the header on
  first load.
- A booking with a live hold shows a counting-down timer; an
  open-seating booking shows none.

Per `docs/self-check-2026-08-26-spec11.md`, run every Playwright
project rather than only the one changed — `customer-app`'s suite had
previously been red for a fixture-shape reason nobody had run into. And
run per `--project=…`, never bare: the four projects interfere.

### Visual review

The §10.6 loop applies in full: capture every customer-app screen at
390px and 1200px in both modes, **read every screenshot**, record
findings in `docs/ui-review/21-passenger-experience/iteration-1.md`, fix,
re-capture, re-verify. This spec's whole subject is how the app looks
and behaves, so a passing axe run is a floor, not the deliverable.

## Migration impact

**None.** No schema change, no data migration, no destructive step. The
only backend change is two computed serializer fields.

## Suggested implementation slicing

Three slices, stop for review between.

**Slice 1 — responsive navigation.** The bottom tab bar, page padding,
and the multi-width overflow tests. Closes the standing recorded defect
on its own, independently of everything else here, and is the smallest
useful thing in this spec.

**Slice 2 — hold countdown.** Serializer fields, `ui-countdown`, and its
two consumers.

**Slice 3 — Senior Mode.** The service, the token set, the root-attribute
styling, the large-QR treatment, the header toggle, and the dual-mode
accessibility sweep.

## Implementation note — slice 1 (2026-09-11)

Frontend only, `customer-app`, and exactly the scope this slice
promised: `AppShell` rebuilt so its nav moves to a fixed bottom tab bar
below Tailwind's own `sm` breakpoint (640px) and stays the original
top-bar row at `sm` and above. No backend change, no data model change —
this slice owns none of spec 21's serializer/API surface.

**Mechanism.** A single `isMobile` signal —
`toSignal(inject(BreakpointObserver).observe('(max-width: 639px)'), ...)`
— gates one `@if` in the template. Only one `<nav aria-label="Primary">`
is ever in the DOM, matching `NavShell`'s own precedent
(`COLLAPSE_BREAKPOINT` in `projects/layout/src/lib/nav-shell.ts`) rather
than inventing a second way to observe a breakpoint. Same
`navLinks`/`routerLink`/`routerLinkActive`/`aria-current` feed both
branches; only the surrounding markup and CSS classes differ, so the
two layouts cannot silently drift apart on which destinations they
link to.

The seven tab-bar entries now carry an icon apiece (`ui-icon`, already
built for the operator apps) rather than text alone — measured
necessity, not decoration: seven equal-width flex columns across a
320px viewport give each label roughly 45px, too narrow to reliably fit
a word like "Bookings" or "Payments" without visual overflow into the
neighbouring tab. Icon choices reuse `client-admin-app`'s own semantics
for the same underlying concept (`document-check` for bookings,
`banknotes` for payments, `credit-card` for wallet, `bolt` for the
pay-as-you-go/Tap & Go credential) rather than inventing a second
meaning for an existing glyph.

`main` gains conditional bottom padding (`pb-24`) whenever the tab bar
is showing, and the bar itself carries
`pb-[env(safe-area-inset-bottom)]` for notched devices — the padding
lives on the bar, not on `main`, because the safe-area inset is chrome
the bar must clear, not spacing the page content needs.

**A real 320px finding, caught by the e2e harness below, not
guessed.** The first cut gave every tab `flex-1` and nothing else. A
flex item's default `min-width: auto` refuses to shrink it below its
own unbreakable content, and these seven labels don't wrap the same
amount — "Tap & Go" breaks after "Tap", but "Payments" and "Journeys"
are one word each and cannot. At 320px that held the single-word tabs
to their wider intrinsic size and left "Tap & Go" measured at **28px**
wide, well under the 44px touch-target minimum. Fixed with `min-w-0`
(let every tab actually take its equal flex share) plus `break-words`
(let a still-too-long word wrap mid-word inside that share rather than
overflow it — the same "wrap, never truncate" rule this spec states
for Senior Mode's long route names, applied here to the same class of
problem).

**What this slice deliberately does not touch.** `validator-app`'s own
top-bar nav carries the identical wrapping risk (`docs/traps.md`) and
is untouched — the spec scopes Senior Mode and this responsive-nav work
to passengers only, and a validator handheld has different ergonomics
of its own. The Activity quick-link (spec 20 slice 4) stays a `home`
card, not a nav destination, for the reason it was built that way: the
bar was already at capacity.

**Verification.** 257 customer-app unit tests (net +2 over the previous
count — `app-shell.spec.ts` rewritten against a faked
`BreakpointObserver`, matching `NavShell`'s own spec convention, rather
than a real one, so these tests do not depend on Karma's actual window
width). `ng lint customer-app`, `tsc --noEmit`, and `ng build
customer-app` all clean. A new `e2e/responsive-nav.ts` harness (one
line per app, following `responsive-tables.ts`'s own shape) drives a
real browser at 320/390/768/1200px against `/my-bookings` and asserts:
exactly one `nav[aria-label="Primary"]`; zero horizontal page overflow;
the bottom bar present only below 640px; every nav link at least
44×44px; and the last interactive control in `main` never hidden
behind the fixed bar once the page is scrolled to its end. All four
widths pass against the real backend (rebuilt from a fresh image and
freshly seeded for this session — the deliberately-withheld
`network.0009_drop_route_is_active` migration confirmed still the only
one unapplied).

Ran the **rest** of `customer-app`'s Playwright suite too, not only the
new spec — `AppShell` is chrome every screen mounts, so a nav rewrite
is exactly the kind of change that regresses somewhere else silently.
It surfaced two real, pre-existing bugs that had never actually been
run to green before (both apparently written and then only
eyeballed manually, per spec 20 slice 4's own Implementation note):

- **`trip-tracking.spec.ts`'s fixture setup called a staff-gated
  endpoint with a passenger token.** `findTripCarryingPassengers` reads
  `GET /bookings/`, gated on `booking.view` (staff-only); the spec
  passed the *passenger's* own token, which 403s there regardless of
  fixture state. The helper trusts `page.results` with no status
  check, so the actual failure surfaced three calls away as `Cannot
  read properties of undefined (reading 'find')`. Fixed by passing the
  staff token instead — full account in `docs/traps.md`.
- **`ui-map`'s zoom control, attribution link and markers stayed
  keyboard-focusable inside the map's own `aria-hidden` container** —
  axe correctly flags a focusable descendant of an aria-hidden
  element, and named the fix in its own failure message. Fixed with
  `keyboard: false` on the Leaflet map and its markers, and
  `tabindex="-1"` swept onto the zoom/attribution anchors (which have
  no such option) right after the map is created. That also happened
  to make axe stop evaluating the attribution link's own 2.55:1 colour
  contrast (no longer reachable, so no longer checked) — but it was a
  real, separate failure in its own right, fixed on its own terms with
  `text-decoration: underline` in both `customer-app`'s and
  `client-admin-app`'s `styles.css` (the rule accepts a non-colour
  distinguishing style as an alternative to contrast, and this is
  Leaflet/OSM's own required text, not this app's copy to recolour).

Both fixes landed in shared code (`ui-map`, `@shared-ui`) or a
`client-admin-app` file untouched by this slice otherwise, so
`client-admin-app`'s own unit suite (728 tests) and its
`live-operations.spec.ts` e2e were re-run too, to confirm the same
component's other consumer wasn't regressed. It surfaced a **third**,
separate, pre-existing contrast bug — `ui-map`'s marker popup ("Simulated
data") at 2.71:1, in `popupHtml()`'s own markup — orthogonal to
responsive navigation and to the two fixes above, so left open rather
than fixed here; recorded in `docs/traps.md`'s known gaps for spec 20's
own follow-up or this spec's slice 3 (which owns the dual-mode WCAG
sweep).

No new trap surfaced in the responsive behaviour itself beyond the
320px flex-sizing finding above; one did in writing this note — see
`docs/traps.md`'s new entry on a literal backtick inside an HTML
comment closing a component's own template literal early, caught by
`tsc` rather than at runtime.

## Implementation note — slice 2 (2026-09-11)

Both halves this slice promised, plus one behavioural correction the
spec's own stated reason for the backend fields required.

**Backend.** `hold_expires_at`/`hold_expires_in_seconds` added to
`BookingSerializer` as two `SerializerMethodField`s, sourced from the
exact same per-booking `SeatReservation` rows `seats` already reads —
`_reservations()` is now the one shared fetch (`reservations_by_booking`
context on the list endpoints, a live per-object query as the
single-object fallback on create/cancel), so this cost no additional
query anywhere the existing query-count tests already guard. Both are
computed from the **earliest `HELD`** reservation's `held_until` only —
deliberately not "any non-released row": a `CONFIRMED` reservation's
`held_until` is a stale pre-payment value the code never clears, and
reading it would resurrect a countdown on an already-paid booking, so
"booking already paid → no countdown" falls out of the `HELD` filter
for free rather than needing its own check. `hold_expires_in_seconds`
is floored at zero for a `HELD` reservation already past its own
`held_until` — the sweep task runs once a minute, so that state is
real and ordinary, not a bug. 7 new backend tests, 1178/1178 total (up
from 1171). `openapi.yaml`/`schema.ts` regenerated, both purely
additive.

**A spec claim corrected against the model, not guessed — the second
one this spec has needed.** Slice 1 corrected `validator-app`'s
scope; this one corrects "open-seating and quick-book bookings hold
nothing." Only open seating holds nothing — `create_booking`'s own
`open_seating` branch never calls `create_reservation` at all. Quick
book is, per `apps/booking/tests/test_quick_book.py`'s own module
docstring, "not open seating: real `SeatReservation` rows are written
against real `Seat`s" — the passenger only doesn't choose which one.
A quick-book booking therefore gets a real countdown here, correctly;
the spec's edge-case table was an overgeneralisation from the open-
seating case it also names, not a fact about quick book specifically.

**Frontend.** Two new `@shared-data`/`@shared-ui` primitives, both
reused as one clock/one component by both consumers:

- `CountdownClock` (`@shared-data`, `providedIn: 'root'`) — one shared
  `setInterval`, ref-counted to subscriber count, paused on
  `visibilitychange`. A deliberately distinct primitive from `Poller`,
  not a reuse of it: `Poller` is one screen's own polling need (a fresh
  instance per consumer); this is one tick source several unrelated
  component instances share, which is what a singleton is for — and
  `Poller`'s `tickFn: () => Promise<void>` shape doesn't fit a
  synchronous local decrement with no server round-trip anyway.
- `Countdown` (`ui-countdown`, `@shared-ui`) — renders from
  `secondsRemaining` alone, never a timestamp; decrements its own local
  counter once a second via `CountdownClock`, never compares against
  `Date.now()` (a wrong device clock still counts down correctly this
  way). Emits `expired` on reaching zero and stops — it does **not**
  assert the hold is gone; both consumers re-fetch and let the server
  decide. `aria-live="polite"` updates only at 5-minute/1-minute/
  30-second/zero crossings, in a region separate from the visible,
  every-second label. Renders nothing when `secondsRemaining` is
  `null`.

**`booking-confirm` no longer navigates to `/my-bookings` immediately
on a successful submit.** This is the one behavioural change beyond
"wire in a display component," and it exists because the spec's own
stated reason for returning both hold fields on the `POST` response —
"so the confirm screen can start counting down without a second
request" — cannot be true of a screen that redirects away in the same
tick it receives them. `createdBooking` now holds the response and the
template swaps the review form for a held/confirmed panel with its own
`ui-countdown`, fed with no second request; "Continue to My Bookings"
is the passenger's own action rather than an automatic redirect, and a
countdown reaching zero there re-fetches through `BookingStore.findById`
(the same "handed an id, need the real thing" lookup `report-issue`
already uses — there is still no single-booking GET for a passenger to
call directly). Bonus, not the goal: the post-submit panel can tell an
open-seating booking from a quick-book one for real (via
`hold_expires_in_seconds`), which the pre-submit review form's own
existing comment already recorded it could not do — both arrive
identically, as a passenger count with no seat choice.

`my-bookings` gained a `ui-countdown` beside the status pill in both
responsive tiers (the `md:hidden` sub-line and the `md:table-cell`
column) for every `pending_payment` row; `expired` reloads the current
page of the list (`BookingStore.getAll()`) rather than any one row —
there is no per-row re-fetch to call instead.

**Verification.** 1617 frontend unit tests total (up from 1598): +7
`customer-app` (net, across `booking-confirm.spec.ts` rewritten for the
new held/confirmed panel and `my-bookings.spec.ts`'s new countdown
tests), +8 `shared-ui` (`countdown.spec.ts`), +4 `shared-data`
(`countdown-clock.spec.ts`). `ng lint`/`tsc --noEmit`/`ng build` clean
across all four apps and both changed libraries. One test-only bug
found and fixed along the way, unrelated to product behaviour: a real,
recurring `ui-countdown` timer keeps Zone.js perpetually "unstable," so
`await fixture.whenStable()` after a countdown is mounted can hang —
`docs/traps.md`'s new entry, fixed with the same `setTimeout(resolve,
0)` idiom this file's own cancel-refetch test already used correctly.

Real-stack verification, not only unit tests: a rebuilt-and-reseeded
backend (same one slice 1 used), a real seated booking driven through
`/search` → seat-picker → `/book`, screenshotted showing "Your seats
are held — pay before the timer runs out" with a live "Held for 14:59"
counting down, then "Continue to My Bookings" landing on a `my-bookings`
list where the just-created row also counts down, older accumulated
`pending_payment` rows correctly show "Hold expiring" (past their
window, unswept, floored at zero rather than negative), and every
`cancelled`/`paid` row shows no countdown at all. Confirmed at 390px
too — the badge wraps into the existing mobile sub-line with no
overflow.

Running the full `customer-app` Playwright suite (not only the new
`ui-countdown` tests) surfaced that `booking-confirm`'s changed
behaviour broke four existing e2e assertions that expected an
immediate post-submit redirect (`booking.spec.ts` ×3,
`open-seating.spec.ts` ×1) — all four updated to click "Continue to My
Bookings" first, and the concurrent-booking race test's winner/loser
detection rewritten from a URL pattern (the winner no longer navigates
anywhere) to reading which of two visible-text markers appears. All
customer-app e2e specs green afterward.

## Implementation note — slice 3 (2026-09-12)

The last slice of this spec, and of the whole Transit OS adoption
roadmap. Frontend only, `customer-app` — no backend or API change, as
the spec's own Data model / API surface sections promised.

**Mechanism, exactly per spec.** `SeniorModeStore`
(`customer-app/app/shared/data/store/`, not `@shared-ui` — the brief
scopes this to passengers, and a store the three operator apps could
accidentally import is one way that boundary leaks) holds a persisted
signal (`integra.senior-mode`, same restore/persist shape as
`@layout`'s `NavCollapseStore`) and reflects it as `data-senior="true"`
on `<html>` via an `effect()` — the one place in `customer-app` that
touches this attribute. Every rule in `theme.css`'s new Senior Mode
block keys off `[data-senior='true']`; no component branches on the
mode in TypeScript or template, per the spec's own "what it must not
do."

**The type scale is `html[data-senior='true'] { font-size: 175% }`,
not a bespoke token.** Every size in this workspace is `rem`-based —
Tailwind v4's own type scale included, and the `--ui-control-height`/
`--ui-row-height`/`--ui-gutter` tokens `[data-surface='consumer']`
already sets — so scaling the root font-size scales all of them
together from one line, which is what the spec's "a custom property
the type ramp already derives from" describes: that property is `rem`
itself. It also composes with a real OS/browser zoom instead of
fighting it (a percentage on the root multiplies whatever size the
platform already chose), and it took `--ui-control-height`'s 44px to
77px for free — comfortably past the spec's 56px floor — without
touching Button/TextField/Select/Checkbox/RadioGroup, which is also
why it was not done by hand-editing those tokens instead.

**Contrast tokens are measured, not judged**, per this codebase's own
rule for `theme.css`: `color.spec.ts` gained a "Senior Mode contrast
tokens clear AAA (7:1)" block alongside the existing AA one.
`--color-default` (ink-700, 10.35:1) and `--color-strong` (ink-900,
17.85:1) already cleared AAA unmodified and needed no override;
`--color-muted` (ink-500, 4.76:1 — AA only) becomes ink-600 (7.58:1),
and the three status tones (danger/success/warning, 5.0–6.5:1 at their
default hue) become darker values that clear 7:1 — danger reuses the
existing `--color-danger-hover` token rather than a new hex.
`prefers-contrast: more` applies the same tokens at `:root`,
independently of the toggle, per the spec's own rule that a system
preference already expressed should not need finding a setting in this
app; Senior Mode's own reduced-motion block is the unconditional
version of the existing `prefers-reduced-motion` one, for the same
reason.

**The header toggle** sits in `AppShell`'s always-rendered `ml-auto`
cluster (bell, sign out) rather than inside the responsive nav, because
that block disappears below `sm` and the spec requires the toggle
reachable "at every viewport." `ui-toggle` carries the accessible name
directly (`label="Senior mode"`); the visible "Senior mode" text beside
it is `hidden sm:inline` (the switch itself never is), and a `sr-only`
paragraph carries the longer explanation via `describedBy` — same
split `business-form.html`'s own toggles already use, since `ui-toggle`
renders no text of its own.

**Large-QR treatment**, on both existing QR screens
(`booking-tickets`, `my-credentials`): the underlying PNG is now
generated at a fixed 340px (up from 220px) in both modes, and displayed
at `--ui-qr-size` (340px under Senior Mode, falling back to the
original 220px otherwise via the Tailwind arbitrary-value default) —
generating at the larger resolution up front means the default-mode
display downscales a sharp source instead of Senior Mode ever upscaling
a blurry one. `booking-tickets.html` gained a "Ticket reference" line
under the QR (the ticket's own id — there is no shorter reference field
on `Ticket`) for the case the spec names: "so a conductor can read it
if the scan fails." `my-credentials.html` already showed the raw token
as text beside its QR from Phase-whatever it was built in; nothing new
was needed there beyond the size change.

### Four real defects found by actually looking, not by the token/mechanism design above

Every finding below, and the fixes, is written up in full in
`docs/ui-review/21-passenger-experience/iteration-1.md` — this is the
short pointer that file's own existence is meant to make possible.

1. **`ui-page-header`'s title/description overflowed and was silently
   clipped instead of wrapping**, on `home` (a passenger's own email —
   `home.ts`'s greeting). Two bugs stacked: `break-words` was missing,
   and — the one that actually mattered — its flex wrappers had no
   `min-w-0`, so each grew to fit the email's own unbreakable width
   instead of ever handing `break-words` a constrained box. Fixed in
   `page-header.ts` (both `min-w-0`s, both `break-words`), with a
   regression test. This bug predates Senior Mode; the larger type was
   only the first thing to push a real passenger email past 390px.
2. **A `document.documentElement.scrollWidth` leak at 390/768px**,
   caught by `e2e/senior-mode.ts`'s own overflow assertion before any
   screenshot showed anything wrong. An `sr-only` live-region span
   (`ui-countdown`, inside `ui-table`'s `md:table-cell` column)
   computed its absolute position against the table's real, wide,
   un-clipped layout and — finding no positioned ancestor — escaped
   `ui-table`'s own `overflow-x-auto` containment entirely, landing
   outside the viewport in the document root's own coordinate space.
   Fixed with `position: relative` on `ui-table`'s wrapper (so it
   becomes the containing block instead of the document root) plus
   `min-w-0` on the same wrapper (the automatic-minimum-size flex bug,
   independently real: without it the wrapper does not shrink to its
   available width in `flex flex-col` — every consumer's own layout —
   in the first place). `app-shell.ts`'s `<main>` also gained
   `overflow-x-hidden` as a backstop and its header row gained
   `flex-wrap` in two places, since even a correctly contained header
   could not fit the larger toggle + bell + "Sign out" on one line at
   320px.
3. **`fullPage` screenshots of a Senior Mode page misplace the fixed
   bottom tab bar mid-image.** Confirmed via a direct viewport
   screenshot that the live app renders it correctly, pinned to the
   bottom, exactly as `e2e/responsive-nav.ts` already asserts — this is
   a Playwright/Chromium limitation capturing `position: fixed`
   elements in a tall, multi-segment `fullPage` stitch, not a product
   defect. No code change; recorded so it is not re-discovered as a
   phantom bug later.
4. **`ui-table`'s dense columns do not adapt to the larger type, and
   can wrap mid-word** (`credentials`' "Type" column: "QR code" →
   "QR"/"cod"/"e" at 390px), and a wide row can push `my-bookings`' own
   "Pay" button past the fold, reachable only by the table's own
   internal scroll. Named as an accepted gap, not fixed: `table.ts`'s
   own docstring already documents a deliberate, three-times-hardened
   decision to freeze this component at console density (`text-sm`,
   never `--ui-text-body`) specifically to hold a 390px fit — and
   `rem`-based root scaling cannot respect that opt-out selectively, by
   construction. A real fix is a narrow-viewport redesign of this
   component (a card layout below a breakpoint), which is
   `docs/specs/14-design-system-and-ui-rebuild.md` territory, not a
   token override; every other Senior Mode requirement (contrast,
   target size, the toggle, QR treatment, motion, page-level overflow)
   holds on every table screen, and no primary action is ever
   unreachable, only reached by scrolling sideways to it.

**Verification.** `SeniorModeStore`: 6 new tests. `PageHeader`: 1 new
regression test (7 total, up from 6). `color.spec.ts`: 6 new AAA
measurements. `AppShell`: 3 new tests (toggle present and wired at both
widths, click flips the store). 1633 frontend unit tests total (up from
1617), green across all four apps' `ng lint`/`tsc --noEmit`/`ng build`.

`e2e/senior-mode.ts` (new, mirrors `e2e/responsive-nav.ts`'s own
structure): no horizontal page overflow at 320/390/768/1200px with
Senior Mode on; axe zero violations at 390/1200px in **both** modes
(the spec's own named failure mode — a contrast token shared carelessly
regressing the default — is what running both modes, not only the new
one, guards against); the toggle keyboard-reachable on first load; every
rendered `.min-h-11` control at least 56px tall with the mode on. All
10 pass. The rest of `customer-app`'s Playwright suite was re-run too
(not only the new spec) — 40 passed, 1 pre-existing skip, and one
pre-existing failure (`open-seating.spec.ts`'s route search finds
nothing, traced to this dev database's accumulated e2e-cruft routes
exceeding the search dropdown's page size — `prune_e2e_test_data`
reduced but did not clear it; unrelated to this slice, not touched
further here).

**The visual pass** — `docs/ui-review/21-passenger-experience/
iteration-1.md` — ran the full §10.6 loop in both modes at all three
capture widths (390/768/1200), not only the spec's own 390/1200:
`ui-review-capture.ts` gained a `UI_REVIEW_SENIOR` env var so the
existing capture list needed no duplication. Two of the four findings
above (the page-header overflow and the scrollWidth leak) were found
this way and fixed before the numbers above; the other two are the
capture-artifact note and the `ui-table` gap, both written up rather
than chased further.

This closes spec 21 and the Transit OS adoption roadmap
(`docs/specs/README-transit-os-adoption.md`). What is **not** closed:
the self-check catch-up for specs 19–21 that `docs/status.md` already
carried as owed before this slice started — three specs deep now, not
two — is still owed, per `CLAUDE.md`'s own rule 5. See `docs/status.md`
for the fuller accounting rather than re-deriving it here.
