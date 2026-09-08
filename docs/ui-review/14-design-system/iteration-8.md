# Spec 14, responsive tables — visual review

Captured 2026-09-01 via `e2e/ui-review-capture.ts`
(`UI_REVIEW_DIR=… npx playwright test --project=<app> --grep @ui-review`),
at 390 / 768 / 1200, across **all three table-bearing apps** rather than
one.

- **`iteration-8/`** — the column tiers as first built.
- **`iteration-9/`** — after F1 and F2.
- **`iteration-10/`** — after F3 and F4.

The capture lists gained `customer-app`'s `journeys` and `payments` and
`super-admin-app`'s `kyb-queue`; none of the three had ever been
photographed.

## What the slice was for

A table that scrolls sideways to reach the only control in the row is
not a usable phone screen. Recorded three times without a fix —
`iteration-2.md` F5, `iteration-4.md` F3, `iteration-6.md` F5 — and
identical in the pre-rebuild baseline each time.

Measured before the change, by the new
`e2e/responsive-tables.ts` guard: `routes` at 390px needed **48px** of
sideways scroll, and `customer-app`'s header forced the *page* to scroll
by **206px**. Both are zero now, at every width, on every screen in the
guard's list.

## Findings

### F1 — Fixed: the passenger nav wrapped into a column

`iteration-8/customer-app/my-bookings-390.png`. Letting the header row
simply wrap removed the overflow and looked broken: six nav links
collapsed into a tall narrow column beside the wordmark, eating a third
of the viewport before any content.

Fixed by giving the nav its own full-width row below `md`
(`order-last w-full`), with the wordmark and the account controls
sharing the row above it. `iteration-9` shows two tidy rows.

The bottom tab bar remains spec 21's. This is the overflow bug fixed,
not that design pre-empted.

### F2 — Fixed: "Review" rendered as three stacked characters

`iteration-8/super-admin-app/kyb-queue-390.png`. `ui-table` had gained
`overflow-wrap: anywhere` so a long unbroken value — a generated route
name, a PSP reference, an email — could not set a column's minimum
width. Applied to the whole cell it also broke the row's own action
button label.

Fixed by exempting `button` and `a` from the rule. A control's label is
not the long value it is aimed at.

### F3 — Fixed: the ledger's Type column broke mid-word

`iteration-9/client-admin-app/ledger-390.png`. Same rule, opposite
problem: "Wallet top-up" rendered as three stacked fragments because the
column was squeezed by a neighbour carrying a booking UUID.

Fixed at that cell with `whitespace-nowrap` rather than by weakening the
global rule — the value is a short fixed label, and `anywhere` is what
lets every other table fit a phone.

### F4 — Fixed: three action links squeezed a name column to one character

`iteration-9` did not catch this; the guard did, on a later run once the
dev database had accumulated more Businesses.
`super-admin-app`'s `business-list` puts three text links — Paystack,
Settlements, Seat hold — side by side in its actions cell. A link's
label is exempt from the break-anywhere rule (F2), so the three of them
together set the column's minimum width and the Name column was squeezed
to **one character per line**, with 65px still overflowing.

Fixed by letting the links wrap (`flex flex-wrap justify-end`) rather
than sitting on one line. A row menu would be the better answer and is
slice 6's, which owns this app.

Worth noting for its own sake: **this guard is data-sensitive**. The
same screen passed earlier in the same session and only failed once the
fixture data grew. A single green run is not proof.

### F5 — Recorded, not fixed: `trip-list`'s filter row still wraps

Unchanged from `iteration-6.md` F4. Four filters plus a capped search box
wrap on a wide screen, leaving whitespace to the right. A filter-bar
layout question, not a table one, and it should be settled with the
filter bar rather than folded in here.

## Confirmed working

- **Every list fits 390px.** Primary identifier with its sub-line, the
  status, and the row's control — nothing else, and nothing off-screen.
- **Nothing is lost.** Hidden columns re-flow into the sub-line; the
  long tail is in the row's drawer. Four new detail drawers were built
  for lists that had none (trips, businesses, ledger, and fares' hidden
  columns re-flow instead, since that screen has no row actions).
- **768px shows the middle tier** — `iteration-8/client-admin-app/bookings-768.png`
  renders route, service date, total, status and actions with room to
  spare, and the sub-line correctly disappears.
- **1200px is unchanged**, which is the point: this slice must be
  invisible on a laptop.
- **`business-list`'s row menu now renders for a read-only user**, who
  previously got no menu at all and would otherwise have lost three
  columns with no way back to them.
- Axe clean on every capture and inside the e2e suites — including one
  real violation this slice *found and fixed*, below.

## Verification alongside the visual pass

- 1056 frontend unit tests, up from 1001: shared-ui 241 (was 222),
  client-admin 446 (418), customer-app 139 (135), super-admin 78 (74),
  validator 42, libraries 110. Four clean builds, lint clean on all nine
  projects.
- **`e2e/responsive-tables.ts` is new and runs in the ordinary suite**,
  not behind `UI_REVIEW_DIR`: three widths × every table screen,
  asserting the page never scrolls horizontally, each table fits its
  container, every row shows as many cells as the header shows columns,
  and no row control sits outside the viewport.
- `client-admin-app` e2e 83/83, `super-admin-app` 19/19,
  `validator-app` 7/7. `customer-app` 13/14 — the one failure is the
  seat-fixture known-red recorded in slice 3b, and fails inside a
  direct-API fixture lookup (`route.stops[0]` on a route with no stops),
  nowhere near this slice.
- No backend change, so no migration and no OpenAPI regeneration.

## Two things worth carrying forward

**A hidden column's value is now in the DOM twice** — once in the cell,
once in the sub-line — so a Playwright `getByText` inside a row is
ambiguous by design. Five assertions across four specs had to become
`expect(row).toContainText(...)`, which is what they meant anyway. Only
one of the two is ever displayed, so screen readers and the visible
page are unaffected.

**`ui-table`'s scroll container was keyboard-inaccessible**, and had
been since it gained a bounded height in slice 3a. Axe caught it
(`scrollable-region-focusable`) only intermittently, on a filtered trips
list whose rows had scrolled away — a scrollable region with no
focusable content inside cannot be scrolled from the keyboard at all.
The container is now a labelled `role="region"` tab stop, and all 25
tables pass it a name.
