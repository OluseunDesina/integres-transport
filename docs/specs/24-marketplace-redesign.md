# 24-Marketplace redesign: a travel-aggregator storefront

Follows spec 22 (the marketplace itself, both slices complete). Spec 22
built `marketplace-app` as a working flow on plain console-style forms and
said its search UX "needs to be proven against the Wakanow/Trip.com
reference". This spec does that: a full visual and UX rework of
`marketplace-app`, baselined on a survey of travel and mobility
aggregators (below), not on any one of them. Frontend only.

## Scope and non-goals

### Reference survey (2026-09-19)

First drafted against Wakanow alone; widened the same day, at the
product owner's request, to aggregators of *travel and mobility options*
— the closer analogue for a multi-operator road marketplace than a
flight/hotel shop. Landing pages were studied live; results pages could
not be reached live (Busbud and FlixBus hand search off to a partner or a
new tab), so the results-page column below is from those products' known
behaviour, not today's observation.

| Product | Why it's relevant | Observed |
|---|---|---|
| Omio | Multi-operator, multi-mode (train/bus/flight/ferry) | One-line search bar (From · To · date · + return · passengers · Search); "Your bookings" in the top bar; popular-connections link lists; app band |
| Busbud | Multi-operator bus + train aggregator | Light hero, one segmented bar with a swap icon between Origin/Destination; value-prop row (support, refunds); operator logo wall; top routes; city → stop hierarchy in suggestions, with stop-type icons |
| FlixBus | Operator-marketplace hybrid | Photo hero; One way / Round trip radio; date field with ‹ › day-steppers; "Manage My Booking" and "Trip Tracker" as top-level nav; city "(all stops)" then individual stops in suggestions |
| Rome2Rio | Mode comparison for one A→B | Result options per mode with duration + price range; **"BEST" / "CHEAPEST" badges on the options themselves**; map beside the list |
| BuuPass (Kenya) | African bus aggregator — closest market analogue | Search bar straight under the banner; **accepted payment methods shown directly under search** (M-Pesa, Airtel, card); partner operators wall; top destinations; volume stats |
| Wakanow (Nigeria) | Original reference | Dark hero with an overlapping search card; trust strip; deals; full footer |
| Treepz (Nigeria) | Checked as a local mobility player | Pivoted to corporate travel/events — no longer a like-for-like reference |

**The baseline — what most of them agree on, and what this spec does:**

| Pattern | Seen in | Here |
|---|---|---|
| Search is the hero, above the fold at every width | all | ✅ slice 1 |
| One segmented horizontal bar on desktop, stacked on phone | Omio, Busbud, FlixBus, BuuPass | ✅ slice 1 (was a two-row card in the Wakanow-only draft) |
| Swap control between From and To | Busbud, FlixBus, Wakanow | ✅ slice 1 |
| Manage-booking reachable from the top bar, signed in or not | Omio, FlixBus, Wakanow | ✅ slice 1 — "My bookings" now shows to guests too |
| Payment methods stated at the point of search | BuuPass, Wakanow | ✅ slice 1 — "card, bank transfer or TransitOS wallet · secured by Paystack" under the bar |
| One-tap recent searches | Omio, Trainline, Busbud | ✅ slice 1 — this browser only, `localStorage` |
| Badges on the winning results ("Cheapest", "Fastest") | Rome2Rio, Omio | ✅ slice 1 |
| Sort by earliest / cheapest / fastest; filter by operator, time, stops | Busbud, FlixBus, Omio | ✅ slice 1 |
| Nearby-dates control on results | Wakanow, FlixBus (‹ › steppers) | ✅ slice 1 (date strip) |
| Passenger count in the search | Omio, Busbud, FlixBus | ➡️ slice 2 — it only means something once the seat picker honours it |
| Seats-left on a result | FlixBus | ✅ spec 22 slice 3 (2026-09-19, independent of this spec) — `capacity_remaining` on the search response |
| Popular routes / top destinations | all six | ⛔ needs a popularity endpoint (see non-goals) |
| Operator logo wall | Busbud, BuuPass | ⛔ needs a marketplace operator-list endpoint and operator logos |
| City → stops hierarchy in suggestions | Busbud, FlixBus | ⛔ stops carry no city grouping today |
| Live trip tracking in the top bar | FlixBus | ⛔ exists in `customer-app` (spec 20), not the marketplace |
| Mode tabs (bus / train / flight) | Omio, Rome2Rio, Wakanow | ⛔ road only — the data model has one mode |
| Round trip / multi-city | all | ⛔ one leg per booking |
| Review ratings, customer counts | Busbud, BuuPass, Wakanow | ⛔ we have none to cite — never invented |

✅ built · ➡️ later slice · ⛔ not buildable honestly on today's API/data
(each is a candidate follow-up, several needing backend work first).

**Deliberately kept from the Wakanow draft:** the navy hero and the
search overlapping its edge. The survey splits here (Busbud and Omio go
light, Wakanow and FlixBus go dark or photographic), so it stays as the
brand choice rather than a baseline rule.

### Slices

- **Slice 1 (this one) — the storefront.** Design language (navy/amber
  marketplace tokens layered over spec 14's theme), `AppShell` header and
  footer, the search landing page, the results page, and the login and
  register screens.
- **Slice 2 — the booking flow.** `seat-picker`, `booking-confirm`,
  `my-bookings`, and `booking-tickets` restyled to match: the summary bar,
  cards, and step indicator introduced in slice 1 applied to the rest of
  the journey. Plus the one baseline pattern that belongs there: a
  passenger count in the search, carried to the seat picker as the number
  of seats to choose, with results showing the total for that many.

  **Stale as of docs/specs/22-marketplace.md's own slice 3 (2026-09-19),
  requested independently of this spec.** That slice removed seat choice
  from `seat-picker` entirely — every booking mode now collects a
  passenger count and one traveler per passenger, with real seats
  auto-allocated server-side at `booking-confirm`'s submit and changeable
  afterward via a new "Change seat" link. It also added the passenger
  count and per-result seats-left this bullet named as slice 2's own
  baseline pattern, and it was not restyled to this spec's navy/card
  language — both screens still use spec 21's plain `border-border`/
  `bg-surface` classes. Whoever picks up slice 2 needs to restyle the
  *current* auto-assign-plus-change-seat flow, not the seat-map flow this
  bullet was written against — the passenger-count/seats-left half of
  this bullet is already done, functionally; only the visual pass and
  `my-bookings`/`booking-tickets` remain.

### Non-goals

- **No backend change and no new endpoint.** Everything below is built
  from `/api/v1/marketplace/stops/suggest/` and
  `/api/v1/marketplace/trips/search/` as they stand.
- **No invented content.** Every surveyed product leans on "Top
  destinations"/"Popular routes" and most on deals, ratings or volume
  stats. We
  have no popularity data and no deals: the stop-suggest endpoint returns
  stops alphabetically, not by demand. A "Popular routes" section would
  either be hard-coded (and lead to empty results when no operator runs
  that route) or would lie. It is left out until an endpoint can back it
  — named, not silently dropped.
- **No prices on the date strip.** Wakanow shows a fare per day; that is
  one search request per day shown. The strip here re-searches on click
  instead.
- **No round-trip / multi-city.** The booking model has one leg per
  booking.
- **No other app changes.** `customer-app` stays on spec 21's design. The
  only shared change is seven new `ui-icon` names (additive).

## Design language

Marketplace-local tokens in `marketplace-app/src/styles.css`, layered on
spec 14's `theme.css` — the marketplace has no white-labelling, so these
never meet `BrandThemeService`:

| Token | Value | Use |
|---|---|---|
| `--color-mk-navy-950` | `#081634` | hero/footer background |
| `--color-mk-navy-900` | `#0c1f4a` | hero gradient stop, header |
| `--color-mk-navy-800` | `#132c66` | hover on navy |
| `--color-mk-accent` | `#fbbf24` | eyebrow text and highlights **on navy only** |
| `--color-mk-on-navy-muted` | `#c7d2fe` | secondary text on navy |

Measured (WCAG, against `#081634`/`#0c1f4a`/`#132c66`): white
17.9/16.0/13.3:1, `#fbbf24` 10.7/9.6/8.0:1, `#c7d2fe` 12.0/10.7/8.9:1 —
all AA. The amber is never a fill behind white text (white on `#fbbf24`
is 1.67:1); where it is a fill, its text is navy-950 (10.7:1). Primary
actions stay spec 14's brand blue (`bg-primary`, white 6.50:1).

Type stays self-hosted Inter; headings use 700 with tight tracking.
Radius goes up a step for consumer cards (`rounded-2xl`), matching the
reference's softer surfaces.

## Behaviour changes (all frontend)

1. **Search landing prefills from query params.** "Modify search" on the
   results page links back to `/search?origin=…&destination=…&service_date
   =…&trip_class=…`, and the form opens filled in. Previously it opened
   blank.
2. **Swap From/To** in one click.
3. **Quick dates**: "Today" and "Tomorrow" chips under the search bar.
   The date input's `min` is today.
4. **Recent searches**: the last four routes searched in this browser
   (one per origin/destination pair, newest first), as chips under the
   bar. A remembered date that has passed is rolled forward to today.
   `localStorage` only, every access wrapped — blocked storage just shows
   none.
5. **"My bookings" in the top bar for guests too**; its route guard asks
   them to sign in.
6. **Results filters** (client-side, over the ≤100 rows already fetched):
   operator, class, departure time of day (before 12:00 / 12:00–17:00 /
   after 17:00), and direct-only. Counts per option. "Clear all" resets.
7. **Sort as tabs** (Earliest / Cheapest / Fastest), each showing its best
   value. Same sort semantics as spec 22 (unset duration sorts last).
8. **"Cheapest" / "Fastest" badges** on the winning cards, over the
   filtered rows: none when fewer than two rows, ties badge every tied
   row, and "Fastest" considers only rows with a known duration.
9. **Date strip**: the searched day ±3, never before today; clicking one
   rewrites `service_date` in the URL, which re-runs the search through
   the existing `queryParamMap` subscription.
10. **The app's root lands on the storefront** (`/` → `/search`), not
   `/login`. Spec 22 slice 2 already made search public; sending a
   first-time visitor to a sign-in wall contradicted that.
11. **Result action reads "Select seats"**, since that is what it does —
   the booking itself is created two steps later. **Reverted to "Book
   now" by spec 22 slice 3** (2026-09-19): once `seat-picker` stopped
   offering seat choice at all, "Select seats" became a false claim
   about what the button does.

## Edge cases

- **Trust strip and payment line claims** must each be true today: every
  operator on the platform in one search (spec 22), choose your own seat
  (spec 8), QR e-ticket (ADR-0005), and card / bank transfer / wallet via
  Paystack (ADR-0007, spec 7). No user counts, ratings, or support hours
  — we have none to cite.
- **A filter that empties the list** shows its own empty state with a
  "Clear filters" action, distinct from "no operator runs that day".
- **Filter state survives a re-sort** but resets on a new search (a
  different day may not have the operator you had ticked).
- **Operator initials avatar** — no operator logos are exposed by the
  search endpoint; the card uses initials on a colour picked
  deterministically from the operator name, never a random one per
  render.
- **Date strip at "today"** omits past days rather than disabling them.
- **Phone (390px)**: hero headline wraps to 2–3 lines, search fields
  stack, the swap button rotates 90°, filters collapse behind a button,
  sort tabs scroll horizontally, and nothing scrolls the page sideways.
- **Guest vs signed-in header**: both see "Search trips" and "My
  bookings"; a guest also sees "Log in" + "Create account", a signed-in
  passenger the notification bell and "Sign out". Below `sm`, "Search
  trips" and "Create account" drop out (the logo is the search link) so
  the bar stays one line at 390px.

## Failure modes

Unchanged from spec 22: a search failure shows `ui-alert` with Retry;
suggestion failures return an empty list. No new request is added, so no
new failure mode.

## Test plan

Frontend unit (`ng test marketplace-app`), updating spec 22's own tests
where the markup they asserted moved:

- `trip-search`: prefills from query params; swap exchanges both fields;
  quick-date chips set the date; a search is remembered and offered back;
  existing navigation assertions unchanged.
- `recent-searches`: newest-first, one per route, capped at four; corrupt
  data and throwing/missing storage never throw; past dates roll forward.
- `search-results`: filters by operator, by time of day, direct-only;
  counts per filter option; clearing filters; date strip excludes past
  days and navigates with a rewritten `service_date`; sort tabs report the
  best value; Cheapest/Fastest badges (incl. single-row and unknown
  duration cases); existing sort/empty/error tests kept.
- `shared-ui` icon spec: the seven new names carry path data.

Visual: the Browser-pane pass at 1280px and 390px over landing, results
(populated, empty, filtered-empty), login and register, with axe clean.
No Playwright project exists for `marketplace-app` (spec 22's own "named,
not fixed") and this spec does not add one.

## Migration impact

None.

## Implementation note — slice 1 (2026-09-19)

**Shipped:** marketplace tokens (`styles.css`), `MarketplaceLogo` and
`MarketplaceAuthLayout` (`src/app/shared/`), a navy `AppShell` with a
four-column footer, the landing page (hero, trust strip, overlapping
search card with swap / quick dates / query-param prefill, how-it-works,
manage-booking band), the results page (summary bar, date strip, filter
sidebar, sort tabs, container-query result cards), split-screen login and
register, `shared/dates.ts` (local-time `YYYY-MM-DD` helpers), and seven
`ui-icon` names. `/` now lands on `/search`.

**How the shell handles width:** landing and results set route data
`fullBleed: true`; every other page keeps the old `max-w-4xl` column, so
slice 2's screens render unchanged inside the new chrome. The flag is
read from `router.routerState.snapshot`, not the live `ActivatedRoute`
tree — reading the live `firstChild` during the shell's construction
threw inside the router and blanked the app. Likewise, one
`<router-outlet>` with a conditional wrapper class, never two outlets
behind an `@if`.

**Verified:** `ng test marketplace-app` 55/55 (spec 22's tests kept;
"Book now" label assertion updated to "Select seats"; new tests for
prefill, swap, quick dates, every filter, filter reset on new search,
sort highlights, the date strip, and `dates.ts`), `ng test shared-ui`
354/354, `ng lint` clean on both. Browser pane at 1280px and 390px on
landing, results (populated, filtered, filtered-empty, no-results),
login and register: no sideways scroll at 390px, and axe (wcag2a/aa +
best-practice) clean on all of them after two fixes it found — the
decorative step numerals (`ink-200` on white) became a "Step N" label,
and the active sort tab's subtitle moved from `text-muted` to
`text-default` (4.3:1 on `primary-subtle`).

**Named, not fixed:**
- The notification bell's trigger is recoloured for the navy bar by a
  descendant selector in `AppShell` rather than a `tone` input on
  `@layout`'s `NotificationBell`. Fine while the marketplace is the only
  dark header; a second one should add the input.
- Everything marked ⛔ in the survey's baseline table — most notably
  popular routes, seats-left, and an operator wall, which every
  surveyed aggregator has and which each need backend work first.
- Still no Playwright project for `marketplace-app`.

**Revision, same day — rebased on the aggregator survey.** After the
Wakanow-only pass the scope widened to travel/mobility aggregators (see
"Reference survey"). Changed as a result: the two-row search card became
one segmented bar from `lg` up (its "Bus & shuttle trips" / "One way"
header dropped); quick dates, **recent searches** (`shared/recent-
searches.ts`) and a **payment-methods line** moved under the bar (the
Paystack item left the hero strip, which now makes three claims);
**"My bookings" shows to guests**; result cards gained **Cheapest /
Fastest badges**; the phone header was cut to one line. Re-verified: `ng
test marketplace-app` 63/63, lint clean, axe clean on landing and results
at 1280px and 390px, no sideways scroll at 390px.

**Next:** slice 2 — `seat-picker`, `booking-confirm`, `my-bookings`,
`booking-tickets` in the same language, plus the passenger count in
search. Owned by this spec.
