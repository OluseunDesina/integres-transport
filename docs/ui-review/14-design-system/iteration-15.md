# Spec 14 slice 5 — visual review

Captured 2026-09-02 via `e2e/ui-review-capture.ts`
(`UI_REVIEW_DIR=… E2E_SKIP_SEED=1 npx playwright test --project=customer-app --grep @ui-review`),
at 390 / 768 / 1200.

- **`iteration-15/`** — the eleven screens as first rebuilt.
- **`iteration-16/`** — after F1, F2 and F3.

The capture list gained `seat-picker` and `booking-confirm`, which are
**half the booking flow and had never been photographed** — neither has
a URL you can navigate to cold, so the flat path list could not reach
them. See "Two screens the harness could not see" below.

## What the slice was for

`customer-app` was the last app still entirely in the pre-rebuild
language: eleven screens of `text-slate-*` literals, a hand-written
`<h1>` on every one, a raw native `<select>`, and no brand presence
anywhere. Underneath that, four things were broken, and the visual pass
found a fifth.

## Findings

### F1 — Fixed: the seat map rendered the bus backwards

`iteration-15/customer-app/seat-picker-390.png`. The map read **3B, 3A,
2B, 2A, 1B, 1A**.

`apps.seating.services.get_availability` reads
`Seat.objects.filter(...)` with no `order_by`, so it inherits
`Seat.Meta.ordering = ["-created_at"]` and returns the seats **newest
first**. `seat-picker`'s row/column path sorts rows and then columns
itself and was never affected; its no-geometry fallback — the case the
fixture vehicle hits — passed the response straight through.

This is the same `-created_at` trap **spec 10 already recorded and
fixed for quick-book seat *allocation*** ("Allocation order is explicit
(row, column, seat number) because `Seat.Meta.ordering` is
`-created_at`, which would scatter a group across the vehicle"). Nobody
checked the seat map a passenger actually looks at.

Fixed in the frontend, with an `Intl.Collator({numeric: true})` so 10A
sorts after 9A rather than after 1A. **The root cause is still the
missing `order_by`** and is worth correcting at the source; this slice
makes no backend change, so it is named rather than fixed. Note also
that `splitAtAisleGaps`' own docstring says its input is "already
sorted by column" — a precondition the backend does not guarantee.

### F2 — Fixed: the step indicator truncated to "Revi…"

`iteration-15/customer-app/search-390.png`. Three labels, three
numerals and two connectors do not fit 390px, so all three truncated —
"Find a t…", "Choose se…", "Revi…".

Below `sm` only the current step is named now. The other labels go
`sr-only` rather than being dropped, so a screen reader still hears
three named steps at any width, and the numbered dots still show
position.

### F3 — Fixed: the Route column was squeezed to about 60px

`iteration-15/customer-app/my-bookings-390.png`. Route, Status and the
actions cell were all competing as visible columns at 390px. A pill
reading "Pending payment" plus Pay plus the menu took everything else,
and "Yaba → Lekki" wrapped to two lines with the sub-line wrapping to
four.

Status now re-flows into the sub-line below `md` like every other
secondary column — the convention `ui-table` already documents — and
leads it, so it is still the first thing read about the row.

### F4 — Recorded, not fixed: the email in a 20px heading

`iteration-16/customer-app/home-390.png`. With no `firstName` on the
account the greeting falls back to the email, which wraps mid-token
across two lines of the largest type on the screen.

The heading now prefers `firstName` (which nothing read before this
slice, despite it being on `AuthUser` since Phase 1), so this is only
the fallback. It is still the fallback the e2e fixture hits, and
`login.spec.ts` asserts the email is in the `<h1>`. Worth a decision
about what to show when a passenger has no name on file; not worth
guessing at here.

### F5 — Considered and kept: "0 seats selected — NGN 0.00"

The summary bar shows a zero total before anything is picked. Slightly
odd, but it is also the only place the currency appears before
selection, and suppressing it makes the bar jump as soon as a seat is
tapped.

## Two screens the harness could not see

`seat-picker` and `booking-confirm` read their subject from router
state and bounce to `/search` when it is absent (`booking-draft.ts`), so
a flat `[name, path]` list cannot reach them. Slice 4 hit the same wall
on `business-kyb` and `seat-map` and worked around it with a throwaway
spec that was then deleted, leaving nothing to reuse.

`CaptureConfig` now takes `flows` — a name and a function that drives
the app to the screen. Both are in the capture set permanently.

**The harness also could not tell a blank page from a good one.** Slice
4 photographed `kyc-status` as three entirely blank images across two
iterations while reporting success, because the capture entry pointed at
`/kyc-status` and the route is `/kyc`. Every capture now asserts a
level-1 heading before writing the file. Verified safe across all four
apps first: every screen in every capture list has exactly one.

## Confirmed working

- **The consumer surface profile does something.** `data-surface="consumer"`
  had been on `customer-app`'s `<html>` since slice 1 and was read by
  one file. Its controls are 16px now; the three consoles are unchanged
  at 14px, asserted rather than assumed.
- **Tenant branding reaches the screen.** `logo` and `name` were read by
  nothing in any app; `app-brand-mark` is their first consumer, on the
  login card and in the header.
- **Paying is a deliberate step.** One tap used to go straight to
  Paystack. It opens a dialog with the amount, the wallet split and a
  button naming where it leads — "Pay from wallet" or "Continue to
  Paystack".
- **The wallet top-up rejects what it should.** `abc`, `-5`, `0` and
  `12.345` no longer reach the API, the message names which rule failed,
  and the field offers a numeric keypad.
- **`my-credentials` has a paginator**, which it never had.
- Axe clean on every capture and throughout the e2e suite.

## Verification alongside the visual pass

- **1136 frontend unit tests**, up from 1091: `customer-app` 175 (was
  139), `shared-ui` 272 (was 247, including the 20 that moved in with
  `form-errors`), `client-admin-app` 459 (was 475 — same 20 moved out,
  4 wrapper tests added). Four clean builds, lint clean on all nine
  projects.
- **`customer-app` e2e 14/14**, up from the 13/14 recorded in slice 4 —
  see below. `validator-app` 7/7, up from 6/7.
- No backend change: no migration, no OpenAPI regeneration.

### Three e2e failures diagnosed rather than assumed

**`customer-app`'s known-red was a bounded fetch, and is now fixed.**
`booking.spec.ts`'s concurrency test resolved its route from one
unbounded `GET /routes/browse/` plus `.find()`. With 43 routes against a
page size of 25 the fixture had fallen off page 1, failing as
`Cannot read properties of undefined (reading 'stops')`.
`e2e/fixture-lookup.ts` already exports `findBrowseRouteByName` — written
for this exact symptom — and this one call site had never adopted it.

**`client-admin-app` is 83/83 with `--workers=1`, and rotates one
failure under parallel workers.** Three consecutive full runs failed
three *different* specs (`schedules`, `routes`, `kyc-status`), each
passing in isolation and on repeat. That is contention on the shared
seeded Client, not a regression — CLAUDE.md already records the
cross-project version of this.

One real staleness did turn up in that project and is fixed:
`kyc-status.spec.ts` still asserted the raw enum `proof_of_address`,
which **slice 4's own F5 fix replaced with "Proof of address"**.

**`super-admin-app`'s KYB queue has grown to 79 rows and the fixture is
row 79 of 79.** `openQueueAtSeededRow` pages to it, which is slow and
flaky, and any sibling test that approves it removes it for the rest.
This is CLAUDE.md's documented `prune_e2e_test_data`-cannot-clear-the-queue
problem, now measured: 36 rows when recorded, 79 now. Not caused by this
slice; the honest fix is seeding, not a spec change.

**Two `validator-app` failures were dev-database state, both cleared.**
Two `FareJourney` rows were left open by aborted runs (one from
2026-08-16 — slice 4's diagnosis, still open), blocking every later board
tap; closing them is what an alight tap does and cannot be done by
deletion, since `TapEvent.journey` is `PROTECT`ed. Separately, all 16
`Yaba → Lekki` tickets had been boarded by accumulated runs, so
`validate-ticket.spec.ts` had no unboarded ticket to work with —
re-running `seed_e2e_users` replenished it. **That spec consumes a finite
fixture supply and nothing replenishes it automatically**, so it
degrades to permanently-red over time. Named for slice 6, not fixed
here.
