# 10-Booking-Modes — visual iteration 1

Screens: `client-admin-app` `businesses/new` (both booking modes) and
`tap-go`; `customer-app` `search/seats` (places mode, `not_configured`
state, and the reservation seat map for comparison) and `book`;
`super-admin-app` `businesses/:id/seat-hold`.

Captured into `iteration-1/`. Authoritative viewports: **390** for
customer-app, **1440** for client-admin and super-admin.

## Defects found

| # | Severity | Screen | Defect | Evidence |
|---|---|---|---|---|
| 1 | High | Business form | The switch's explanation is a loose `<p>` with no `aria-describedby` — sighted users get the guidance, screen-reader users get a bare "Let passengers choose their seat" switch. `ui-select` gained a `hint` input for exactly this in spec 12, and CLAUDE.md records the trap by name | `iteration-1/business-form-open-seating-1440.png` |
| 2 | High | Booking confirm | "your places are held once you reserve" is **false** for open seating. Nothing is held — a place is counted when a ticket is issued at payment. The copy was inherited from the reservation flow, where it is true | `iteration-1/places-confirm-390.png` |
| 3 | Medium | Seat picker | The heading reads "How many passengers?" directly above "Not open for booking yet" — a question about a departure that cannot be booked | `iteration-1/not-configured-390.png` |
| 4 | Low | Seat picker | "1 passenger(s)" — the parenthetical plural the fare-matrix review already flagged once, in new code | `iteration-1/places-picker-390.png` |
| 5 | Low | Seat picker | "Seats aren't assigned in advance on this service — sit anywhere that's free" is shown for **quick book** too, where seats *are* assigned (the passenger just does not pick one) | `iteration-1/places-picker-390.png` |

## Outside this slice, and not fixed

| # | Severity | Screen | Defect | Evidence |
|---|---|---|---|---|
| 6 | **High** | `customer-app` app shell | The passenger nav collapses at **390px, the authoritative passenger viewport**: "Tap & Go" wraps onto three lines, "Sign out" overlaps "Journeys", and the header forces horizontal overflow past the viewport | every 390 capture in `iteration-1/` |

Defect 6 is pre-existing — nothing in this slice touches `app-shell` —
and fixing it properly means a responsive/collapsing nav for the
passenger app, which is its own piece of work rather than a CSS tweak
smuggled into a booking-modes slice. It is recorded here rather than
quietly left out: it is on the authoritative viewport of every
customer-app screen this slice added, and it is the most serious visual
defect on any of them.

## Fixed in iteration 2

1 → `ui-toggle` gained a `describedBy` input, wired to
`aria-describedby` on the real `<button>` (not the host, which is
`display: contents` — the trap that component's own docstring
documents). Locked in by a component test that reads the id back and
checks the text it points at.

2 → the two cases now say different things, because they *are*
different mechanisms. Choosing seats holds them; buying places may hold
nothing at all. The confirm screen cannot tell open seating from quick
book (both arrive as `kind: 'places'`), so its wording there is one that
is true of both: "your booking is confirmed once you pay."

3 → the heading falls back to "Your journey" whenever `status` is not
`open`.

4 → real pluralisation, asserted on the exact singular and plural
strings.

5 → the hint is now derived from `booking_mode`: open seating says "sit
anywhere that's free", quick book says "this operator assigns seats for
you".
