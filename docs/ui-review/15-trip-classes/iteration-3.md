# Spec 15 slice 3 — visual review

Captured 2026-09-03 via `e2e/ui-review-capture.ts`, at 390 / 768 / 1200.

```bash
UI_REVIEW_SPEC=15-trip-classes UI_REVIEW_DIR=iteration-3 E2E_SKIP_SEED=1 \
  npx playwright test --project=customer-app --grep @ui-review
```

`iteration-1`/`iteration-2` were slice 2's `client-admin-app` pass;
this is `customer-app`, so it starts at `iteration-3` rather than
restarting the numbering.

`customer-app`'s capture list gained four `flows`. Three of them exist
because the flat `screens` list photographs `search` as an **empty
form** — the class pills, which are this slice's whole visible surface
on that screen, were not in the capture set at all. `search-results`,
`seat-picker-premium` and `booking-confirm-premium` fix that, the last
two filtered to Premium so the capture shows a class that is not the
default and a fare that is not the wildcard's.

The fourth, `booking-tickets`, resolves a paid Booking's id **through
the API** rather than by clicking through `my-bookings`. The first
attempt walked the list and paged forward looking for a `Paid` row;
this passenger's list is 435 rows deep and newest-first, so every paid
fixture sits many pages back and the walk was paging for its own sake.
Same conclusion `fixture-lookup.ts` already reached for list endpoints.

## No blocking defects

Unusual for a visual pass, and worth saying plainly rather than
implying it by omission. Every changed screen holds at all three
widths, axe is clean on every capture and throughout the e2e run, and
the one layout change to an existing screen (`Travel date` giving up
its `sm:col-span-2` so `Class` can pair with it) reads as intended at
768 and 1200 and stacks at 390.

## Confirmed working

- **The load-bearing assertion is visible in a screenshot.**
  `booking-confirm-premium-390.png` reads `Service: Premium` and
  `NGN 1250.00`, and `seat-picker-premium-1200.png` reads
  `NGN 1250.00 per seat`. The wildcard rule on that same route is 750.
  A Premium departure priced from the wildcard would show 750 with
  nothing on screen saying so — that is the failure this slice exists
  to make impossible, and it is now photographed as not happening.
- **Both classes are legible side by side.**
  `search-results-1200.png` shows eleven `Standard` departures and one
  `Premium`, each pill neutral-toned with its label carrying the whole
  signal. Colour differentiates nothing here on purpose.
- **The class survives the whole flow.** Search card → seat-picker
  journey line (`… · Premium service`) → confirm's `Service` row →
  `my-bookings` route cell → the ticket's own `Service` row.
- **390px holds on the two tightest screens.** `my-bookings` still fits
  its four columns plus the class pill (long route names wrap the pill
  to a second line rather than squeezing the route — the right
  trade-off, since truncating the route is worse), and the seat-picker
  journey line wraps to three lines without pushing the seat map.
- **The narrowed filter is real, not decorative.**
  `search-768.png` offers `All classes`, `Premium`, `Standard` — the
  seeded route's allow-list — not all four.

## Two things named, neither fixed

### N1 — The ticket screen still names no journey

`booking-tickets-1200.png`. The card now reads `Service: Standard`,
`Issued`, `Valid until` — and **no route and no departure time**. The
class is now the only journey-shaped fact on a ticket, and it is the
least identifying one: a passenger holding two tickets for two
different trips of the same class sees two QR codes distinguished by an
issue timestamp.

This is pre-existing — the screen has never carried a route — but
adding the class sharpens it, because it makes the absence of the other
two obvious in a way three timestamps did not. Fixing it means route
and departure on `TicketSerializer`, which is spec 6's surface and a
different set of fields from the one this slice was scoped to. Named
here so it is a decision rather than an oversight.

### N2 — Every row shows the same class, in this database

`my-bookings-1200.png` is 25 rows of identical `Standard` pills. That
is a property of the dev fixture, not of the design (the passenger has
bought nothing else), but it is what a real single-class operator's
passengers would see too.

Suppressing the pill when the class is `standard` was considered and
rejected: Standard is a real product tier here, one of four, not the
absence of one. "No pill" would then mean either "standard" or
"something this build does not recognise", and the ambiguity is worse
than the repetition.

## Verification alongside the visual pass

- **799 backend tests**, up from 797 — one per new serializer field.
- **187 `customer-app` unit tests**, up from 172. 1238 across the
  workspace, up from 1223. Four clean builds, lint clean on all nine
  projects, OpenAPI drift clean both directions.
- **All four e2e projects green**, `customer-app` at 18 including the
  new `trip-classes.spec.ts`, run twice to confirm it is repeatable
  against a database that keeps everything previous runs wrote. The
  shared bookable-route fixture gained a Premium half, so
  `client-admin-app` (86) was re-run for the same reason `CLAUDE.md`
  records: the last change to this fixture left another project's suite
  red for weeks.
