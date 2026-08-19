# Phase 4 (addendum): Fare Versioning and Price Snapshotting

**This document is retroactive.** Cursor built this feature — versioned
`FareRule`/`FareSegmentRule` rows, price/fare-rule snapshotting on
`SeatReservation`, and `Booking.currency` — without a prior spec,
discovered during this session's verification pass of the Phase 4
frontend addendum. Per the working agreement's "spec before code" rule,
nothing should ship unspec'd; this document supplies that spec after
the fact, describing what was actually built (verified against the real
code, not assumed), so it can be reviewed on the same terms every other
piece of this codebase is. It also **corrects and supersedes** the
now-stale parts of `docs/specs/4-fares-seating-booking.md` — that
document's §2 and §3 still describe `FareRule`/`FareSegmentRule` in
their pre-versioning shape (a plain `is_active` boolean, `FareRule`
unique per Route, in-place `PATCH`). That original spec is not edited
in place here (its own implementation notes are a historical record of
what Slice 1 actually shipped at the time); this addendum is the
current source of truth for `apps.fares`' data model and API surface
going forward.

## 1. Scope and non-goals

**In scope**: what already exists in the working tree —
`FareRule`/`FareSegmentRule` gaining an effective-dated validity window
(`effective_from`/`effective_to`), a `supersede` operation replacing
in-place editing, a GiST exclusion constraint preventing two overlapping
validity windows for the same Route (or Route+stop-pair), and
`SeatReservation`/`Booking` snapshotting the exact price, originating
fare rule, and currency used at booking time so a later fare change
never retroactively alters what a passenger already booked.

**Why this is a real need, not scope creep for its own sake**: without
it, editing a `FareRule`'s `amount` (the only mutation the original
spec described) would silently change the price of every *existing*
`pending_payment` Booking that referenced it — `get_fare()` was called
once at booking time in the original design, but nothing stored what it
returned, so a support/ops fare correction made after a passenger
booked would retroactively move their price. That's a real, money-
adjacent correctness gap. It's a legitimate fix; the problem is
procedural (unreviewed, unspec'd, undiscussed), not that the fix itself
is wrong.

**Explicitly out of scope / not built:**

- **No fare-history UI or endpoint.** `GET /fare-rules/?route=` returns
  every non-deleted row (past and current) for a route with no
  dedicated "history" view — technically visible, not purpose-built.
- **No frontend surface at all.** Confirmed by search: no
  `client-admin-app` screen reads or writes `FareRule`/`FareSegmentRule`,
  `effective_from`/`effective_to`, or the supersede endpoint. Fare-rule
  management today is API-only (Postman/curl), same as before this
  feature existed — it was already out of the frontend addendum's scope
  (`docs/specs/4-fares-seating-booking-frontend.md` never mentions
  fare-rule management), and remains so.
- **No new permission codename.** `PATCH` now supersedes rather than
  edits in place — a materially different operation — but still gated
  on the pre-existing `fares.manage`, not a distinct codename.
- **No backfill correctness guarantee for pre-existing data.** The
  migration that backfilled `SeatReservation.amount`/`.fare_rule` for
  rows that predate this feature divides `Booking.total_amount` evenly
  across its seats and synthesizes a covering `FareRule` if no real one
  matches — a heuristic, not a reconstruction of history. Irrelevant in
  practice today (this repo has no committed data, still zero git
  commits, and every environment is dev/e2e-seeded), but would need
  re-examination before this shape ever runs against real historical
  bookings.

## 2. Data model changes

### `apps.fares.FareRule`

| Field | Type | Notes |
|---|---|---|
| `business` | FK → `businesses.Business`, `on_delete=PROTECT` | unchanged |
| `route` | FK → `network.Route`, `on_delete=PROTECT` | **no longer unique** — a Route now has a history of `FareRule` rows, not one |
| `amount` | `DecimalField(10, 2)` | unchanged |
| `effective_from` | `DateTimeField` | **new** — half-open window start |
| `effective_to` | `DateTimeField(null=True, blank=True)` | **new** — `null` = open-ended (the current rule) |

`is_active` **removed** (destructive — see §7). `Meta.ordering` changed
to `["-effective_from", "-created_at"]`.

**DB-only exclusion constraint** (raw SQL in the migration, not
expressed in `Meta.constraints` — same pattern `docs/adr/0004`'s seat
constraint uses):

```sql
ALTER TABLE fares_farerule
  ADD CONSTRAINT no_overlapping_fare_rule_per_route
  EXCLUDE USING gist (
    route_id WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  )
  WHERE (deleted_at IS NULL);
```

### `apps.fares.FareSegmentRule`

Same shape, keyed additionally on `from_stop`/`to_stop`. Its own
exclusion constraint partitions on `route_id, from_stop_id, to_stop_id`.
The old `unique_fare_segment_per_route` constraint is **dropped**
(destructive — see §7), replaced by the exclusion constraint.

### `apps.seating.SeatReservation` — price/rule snapshot

| Field | Type | Notes |
|---|---|---|
| `amount` | `DecimalField(10, 2)`, not null | the per-seat price actually charged, frozen at booking time |
| `fare_rule` | FK → `fares.FareRule`, `on_delete=PROTECT`, nullable | set when the Business is in `flat` pricing mode |
| `fare_segment_rule` | FK → `fares.FareSegmentRule`, `on_delete=PROTECT`, nullable | set when `per_segment` |

`CheckConstraint("seat_reservation_exactly_one_fare_rule")`: exactly one
of `fare_rule`/`fare_segment_rule` is set, never both, never neither.
Both FKs are `PROTECT` — a `FareRule` referenced by any historical
`SeatReservation` can never be hard-deleted, only closed via supersede.

### `apps.booking.Booking` — currency snapshot

`currency = CharField(max_length=8)`, not null — `Business.currency` at
booking creation time, so a later change to a Business's operating
currency never relabels an existing Booking's already-charged amount.

## 3. API surface

`POST /fare-rules/` / `POST /fare-segment-rules/` — unchanged shape,
plus an optional `effective_from` (defaults to "now" — a future value
schedules a rule that isn't yet in effect).

`PATCH /fare-rules/{id}/` / `PATCH /fare-segment-rules/{id}/` —
**semantics changed from in-place edit to supersede.** Body is now
`{amount, effective_from?}`, not an arbitrary partial update. The
response is the **new successor row** (`response.data.id !=` the path
id) — the original row is closed (`effective_to` set to the supersede
boundary) and its own `amount` is untouched. Superseding an
already-closed rule (one that isn't the current open-ended version)
returns `400` (`FareRuleClosed`). An overlap the exclusion constraint
would reject surfaces as `400` (`FareOverlap`), not a raw `500` from an
uncaught `IntegrityError`.

`GET /trips/{id}/fare/` — unchanged request/response shape.
Internally, `get_fare()` resolves the applicable rule via `as_of`
(defaults to `now()`), and `create_booking()` calls it with no `as_of`
override — **a purchase-time quote**. A fare scheduled to change next
month does not affect a booking made today, and a booking made today is
never affected by a fare edited after the fact (§2's snapshot fields are
what make that true structurally, not just at quote time).

No new permission codenames — both endpoint pairs remain gated on the
pre-existing `fares.view`/`fares.manage`. No new rate limits.

## 4. Edge cases

- **Superseding a rule while a booking is mid-flight against the old
  one** — the booking's `create_booking()` call already resolved and is
  writing its own snapshot; the two operations don't conflict at the
  row level (`supersede_fare_rule` locks the rule being closed via
  `select_for_update()`, not any `SeatReservation`).
- **A future-dated `effective_from`** — `get_fare()` at the current
  moment does not see it; `FareNotConfigured` is raised if no *currently
  covering* rule exists even though a future one does (test-verified:
  `test_get_fare_raises_when_only_a_future_rule_exists`).
- **Two concurrent supersede attempts on the same rule** — the DB
  exclusion constraint is the final arbiter (same posture as ADR-0004's
  seat constraint); the loser gets `FareOverlap` → `400`.
- **A Business's `fare_pricing_mode` switching between `flat` and
  `per_segment`** — unchanged from the original spec's own documented
  behavior (old rows aren't deleted, lookups just use the new mode's
  rule type).

## 5. Failure modes

- **Exclusion constraint violation on a genuine overlap** — `400`
  (`FareOverlap`), not `500`, mirroring how the seating app's own
  exclusion constraint is surfaced.
- **A rule closed by supersede is referenced by a historical
  `SeatReservation`** — safe by construction: `PROTECT` prevents the row
  from ever being deleted, and the snapshot fields mean nothing needs to
  re-read the (still-existing, just closed) rule to know what a past
  booking cost.

## 6. Test plan

Already built and passing (346/346 full backend suite, verified this
session) — not new work, documenting what exists:

- `apps/fares/tests/test_fare_versioning.py` (244 lines, 8 tests):
  supersede closes the old row and creates a readable successor;
  `get_fare()` resolves the correct amount on either side of a supersede
  boundary; a future-dated supersede doesn't affect today's quote; the
  DB itself rejects an overlapping window (bypassing the service layer,
  proving the constraint, not just the Python guard); a booking records
  its own per-seat amount/currency/originating rule;
  **`test_editing_a_fare_after_a_booking_leaves_the_snapshot_untouched`**
  — the load-bearing regression test for this entire feature's reason
  to exist; patching a closed rule is rejected; `get_fare()` raises when
  only a future rule exists.
- `apps/fares/tests/test_fares.py` — 2 more supersede-specific tests
  confirming the HTTP-level response id differs from the path id and
  both `fare_rule.superseded`/`fare_rule.created` audit events land with
  correct `target_id`/metadata.

No frontend/e2e test plan — §1 already establishes there's no frontend
surface to test.

## 7. Migration impact — contains destructive steps, already applied

**Not additive-only**, unlike every other Phase 4 migration.
`apps/fares/migrations/0002_version_fare_rules.py` — already applied to
the dev database as part of this session's verification — includes:

- `RemoveField(FareRule, "is_active")` — destructive, no rollback path
  that recovers the original boolean values (the migration has no
  reverse operation for this specific step).
- `RemoveConstraint(FareSegmentRule, "unique_fare_segment_per_route")` —
  replaced by the exclusion constraint, not simply dropped-and-gone.

Sequenced zero-downtime-style (additive columns → backfill → enforce
`NOT NULL` → drop old constraints → add new ones), and the backfill
(`0002`'s own `RunPython`) correctly runs under an RLS
platform-staff bypass. `apps/seating/migrations/0003–0005` and
`apps/booking/migrations/0002` are additive-then-backfill-then-enforce
in the same style, with one already-flagged caveat: `0004`'s backfill
heuristic (§1) for pre-existing `SeatReservation` rows.

**Because these migrations already ran** (this is a working dev
database, not a proposal), there is nothing to approve retroactively
that hasn't already taken effect — this section exists so the
destructive steps are on the record, not to request permission for
something already done. Any future environment applying migrations from
scratch will pass through the same sequence automatically.

## 8. Relationship to `docs/specs/4-fares-seating-booking.md`

That document's §2 (`FareRule`/`FareSegmentRule` fields, `is_active`)
and §3 (`PATCH /fare-rules/{id}/` as an in-place edit, audited
`fare_rule.updated`) are **superseded by this addendum** and should be
read as historical (accurate to what Slice 1 shipped at the time, not
to the current schema). No edit lands in that file itself — it stays a
record of what was actually built and reviewed in each of its own three
slices, matching every other spec in this repo's convention of not
retroactively rewriting a slice's own implementation notes.
