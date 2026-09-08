# Spec 18 slice 1 — visual review

Captured 2026-09-07 via `e2e/ui-review-capture.ts`, at 390 / 768 / 1200.

```bash
UI_REVIEW_SPEC=18-manifest UI_REVIEW_DIR=iteration-1 E2E_SKIP_SEED=1 \
  npx playwright test --project=client-admin-app --grep @ui-review
```

Two capture entries were added, and they are **flows rather than
screens**: the manifest needs a real Trip id, and it needs one with
passengers actually on it. `trip-manifest-prepaid` and
`trip-manifest-pay-as-you-go` are separate entries because `kind` makes
them genuinely different tables — one lists tickets and seats, the other
journeys and board/alight stops, and one has a cancelled toggle the
other must not. Photographing one would have left half the screen
unreviewed.

## One defect in the screen

### F1 — the header could not say which fact was missing (fixed)

`iteration-1`, both `trip-manifest-*-1200`. The line under the route
read:

```
7 Sep 2026, 09:30 · E2E-3456-LA · Not recorded
```

A registration number and a driver's name look nothing alike, but
**"Not recorded" looks like either** — so the one piece of information
the line was failing to give was also the one you could not identify.
Now labelled, and the absent case says what is absent:

```
7 Sep 2026, 09:30 · Vehicle E2E-3456-LA · No driver assigned
```

Consistent with the Capacity stat beside it, which already said
"No vehicle assigned" rather than `0` for the same reason.

### F1b — the table overflowed at 768px, and again at 390px (fixed)

`iteration-2`, `trip-manifest-prepaid-768`. Six columns came to **690px
inside a 654px wrapper**, clipping the Ticket column and putting every
row behind sideways scroll. Measured rather than eyeballed. Fare moved
to the **third** tier (`lg:table-cell`) — it is the column an operator
at the door needs least, it is already in the `md:hidden` sub-line
below `md`, and it is in the CSV at every width.

Then the guard found a second one the screenshots did not show: 3px over
at 390px, caused by `whitespace-nowrap` holding "Open seating" on one
line. A two-line cell costs less than sideways scroll on every row.

**The reason both were found late is that this screen was not in
`e2e/responsive-tables.ts`** — the guard `ui-table`'s own docstring
points at. It could not be: that harness takes fixed URLs, and a
manifest needs a Trip id, of a trip that carries passengers. It now
accepts a resolver function for a path, and `trip-manifest` is in the
list. The one table in the app that most needed measuring had been the
one table the guard could not reach.

## Two defects in the capture harness, both blocking

Neither is in this slice's screens, and both stopped the whole pass —
so every later screen went unphotographed and the run reported one
failure with no useful detail.

### F2 — the `incident-detail` walk still trusted page 1

Spec 17 slice 3 added two more sources filing incidents into the same
Business, and this walk clicked `INC-E2E001` on the queue's first page.
The fixture is now many pages deep. `incidents.spec.ts` had already been
fixed to search for it; **the capture spec had not**, and nothing linked
the two. It searches now — and by role, since the active search renders
a removable chip carrying the same string.

### F3 — the fixture lookup filtered to `paid`, which the fixture is not

`findTripCarryingPassengers` asked for a paid booking on the route. A
ticket is issued at payment and the booking **completes** once that
ticket is boarded, so the seeded open-seating fixture — deliberately
boarded — reads `completed`, and the lookup found nothing. Both statuses
carry tickets; the ones that do not are exactly the ones whose manifest
would be empty anyway.

Worth recording beyond the fix: the lookup is deliberately resolved
**through the rows** rather than through `GET /trips/`. Picking a trip
by route and date returns an *empty* departure most of the time, because
`seed_e2e_users` creates a fresh trip per run while the seeded booking
sits on an older one — and a manifest spec pointed at an empty trip
passes its navigation assertions while proving nothing about the table.

## What the pass confirmed rather than found

- **`kind` reads as two different tables.** The PAYG capture shows
  board → alight, "Alighted", and no cancelled toggle; the prepaid one
  shows references, seats and two status columns.
- **"Open seating" fills the Seat column** on a trip that sells places
  rather than seats, instead of eight blank cells.
- **The "A tap is the boarding on a pay-as-you-go trip" hint** is
  carrying its weight: Passengers and Boarded both reading 2 looks like
  a bug until that line explains it.
- Every status pill carries a text label; references and dates do not
  break mid-token at any width.
- Axe clean on both screens at all three widths.
