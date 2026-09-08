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
