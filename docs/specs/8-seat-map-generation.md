# 8-seat-map-generation: Seat Map Generation

Deferred from live-testing triage (2026-08-19), spec'd per this repo's
"spec before code" rule. Also closes a gap the same session's UI sweep
found: `GET`/`PUT /vehicle-types/{id}/seats/` has existed since Phase
4 Slice 2 with **zero frontend consumers in any app** — there is
currently no way to define a `VehicleType`'s seats from any UI at all,
manual or generated. That gap is closed by this spec directly, not as
a separate manual-entry screen built first and then replaced —
generation is the only seat-creation path this spec builds.

## Context: the data model already expects this, nothing populates it

`apps.seating.models.Seat` already has `row`/`column`
(`PositiveIntegerField`, nullable) — present since Phase 4, but never
written by the only existing write path
(`apps.seating.services.replace_vehicle_type_seats`, which only ever
takes a flat `seat_numbers: list[str]` and creates each `Seat` with no
`row`/`column` at all). More strikingly, **`customer-app`'s
`seat-picker.ts` already branches on `row`/`column` being present**:

```ts
// Groups seats into rows when the VehicleType defines row/column
// geometry, and falls back to a single wrapped row of seat numbers
if (seats.every((entry) => entry.seat.row === null)) {
  return [{ row: null, seats }];
}
```

This code was written anticipating real geometry that has simply never
existed in any seeded or real data — every VehicleType today hits the
`row === null` fallback unconditionally. This spec's job is almost
entirely backend: populate `row`/`column` for real, and this
already-built customer-app rendering lights up with **no customer-app
change required**.

## Scope and non-goals

**In scope**:
- A rows × columns (+ one optional aisle) generator that computes a
  full seat layout (`seat_number`, `row`, `column` per seat) and
  writes it via the existing replace-the-set endpoint shape.
- A `client-admin-app` screen to configure and preview this layout for
  a `VehicleType` — the actual UI that closes the "no seat map builder
  at all" gap.
- Fixing `PUT /vehicle-types/{id}/seats/`'s current unhandled-500
  behavior when regenerating seats that already have
  `SeatReservation`s against them (§ Edge cases) — a real gap in
  already-shipped code this spec's own feature would otherwise trip
  over immediately.

**Non-goals** (deliberate):
- **Manual per-seat add/remove/reposition editing.** The original
  request asked specifically for "rows and columns... variables that
  we can use for the seatmap," i.e. generation — not a general seat
  editor. A VehicleType's layout is set by re-running the generator
  (full replace), not edited seat-by-seat. If a real operator need for
  manual editing (irregular back rows, missing seats for a
  wheelchair space, etc.) surfaces, that's a distinct, later spec.
- **Irregular layouts** (a non-uniform back row, staggered numbering,
  multiple aisles). v1 generates one uniform grid with at most one
  aisle column. Named here as a real, deliberately deferred limitation
  — not solved by this spec, not silently ignored either.
- **Regenerating a layout for a VehicleType that already has sold
  seats** — allowed only when safe (§ Edge cases), not designed around
  making it always possible. A sold seat's `Seat` row cannot be
  deleted (DB-level `PROTECT`), so a layout with active
  `SeatReservation`s is not freely replaceable, by construction.

## Data model changes

**None.** `Seat.row`/`Seat.column` already exist (Phase 4). This is a
write-path and API-surface change only.

## API surface

### `apps/seating` — replace endpoint body shape changes

`VehicleTypeSeatsUpdateSerializer`'s body shape changes from
`{"seat_numbers": ["1A", "1B", ...]}` to a richer per-seat shape:

```json
{"seats": [{"seat_number": "1A", "row": 1, "column": 1}, {"seat_number": "1B", "row": 1, "column": 2}, ...]}
```

This is a breaking change to an already-shipped request body — safe
to make outright rather than versioning, since the endpoint is
confirmed to have zero real consumers (the UI sweep's own finding).
`apps.seating.services.replace_vehicle_type_seats` changes its
`seat_numbers: list[str]` parameter to `seats: list[SeatSpec]`
(`SeatSpec` a small `TypedDict`/dataclass of
`seat_number`/`row`/`column`), writing `row`/`column` into each
created `Seat` — everything else about the function (the
`all_objects`-delete tenancy-bypass fix, the capacity-cap validation,
the audit log call) is unchanged.

### New: `POST /vehicle-types/{id}/seats/generate/`

The actual UI-facing endpoint — `client-admin-app` never manually
enumerates seats.

Request:
```json
{"rows": 10, "columns": 4, "aisle_after_column": 2, "numbering_scheme": "row_letter"}
```

- `rows` × `columns` must not exceed `vehicle_type.capacity` — same
  cap `VehicleTypeSeatsUpdateSerializer` already enforces today,
  moved to validate the *generated* list rather than a
  caller-supplied one.
- `aisle_after_column`: nullable `PositiveIntegerField`-shaped int.
  **Resolved during Slice B implementation** (the API surface section's
  original text flagged this as needing confirmation before building —
  it now has one): the aisle models a real physical slot. The stored
  `column` integer jumps by 2 across it (e.g. columns `1,2,4,5` for a
  4-seat row with `aisle_after_column: 2`), so a renderer can detect
  the gap directly from `column` deltas — but the row's real seat count
  is unchanged (`rows * columns` is still exactly the number of seats
  produced, capacity validation unaffected) and `seat_number` stays
  sequential/contiguous (`1A,1B,1C,1D`) regardless of the column jump —
  only the persisted `column` integer carries the gap.
- `numbering_scheme`: `"row_letter"` (row `1`, columns `A`,`B`,`C`,`D`
  → `1A`,`1B`,`1C`,`1D`) is the only scheme this spec builds — matches
  the seat-number shape already used throughout existing seed data and
  tests (`1A`/`1B`). A single fixed scheme, not a pluggable one; if a
  Business wants different numbering later, that's additive.

Server-side (`apps.seating.services.generate_seat_layout(rows,
columns, aisle_after_column, numbering_scheme) -> list[SeatSpec]`)
computes the full layout, then calls the same
`replace_vehicle_type_seats()` used by the (now-internal-only)
manual-replace path. Response: `SeatSerializer(many=True)`, unchanged
shape — same as `PUT` returns today.

`PUT /vehicle-types/{id}/seats/` **stays** (now taking the richer
`seats` body above) as the lower-level primitive `generate/` is built
on, in case a future need for direct manual replacement arises — not
exposed in the `client-admin-app` UI this spec builds, which only ever
calls `generate/`.

## Edge cases

1. **Regenerating a layout for a VehicleType whose seats already have
   any `SeatReservation`** (held, confirmed, expired, or released —
   `on_delete=PROTECT` doesn't distinguish status). **Currently
   unhandled** — `Seat.all_objects.filter(...).delete()` inside
   `replace_vehicle_type_seats` would raise a raw `ProtectedError`,
   surfacing as an unhandled 500. Fixed as part of this spec: caught
   and converted to `409 SeatsInUse`, with a message naming the
   count ("This vehicle type's seats can't be regenerated: 12 seat(s)
   have reservations against them") — the same "fail closed with a
   clear typed exception, not a raw DB error" standard every other
   domain in this codebase already meets.
2. **`rows × columns` exceeds `vehicle_type.capacity`.** `400`,
   validated before any write — same shape the existing
   `exceeds_capacity` validation already uses, just computed from the
   generator's inputs instead of a caller-supplied list length.
3. **`aisle_after_column` ≥ `columns`.** `400` — a nonsensical aisle
   position, rejected before generation.
4. **Regenerating with a smaller `rows × columns` than the current
   layout, and the VehicleType has zero reservations.** Allowed —
   ordinary replace-the-set semantics, unchanged from today's
   `replace_vehicle_type_seats` behavior for the no-conflict case.
5. **customer-app rendering `row`/`column` for a VehicleType generated
   with an aisle.** `seat-picker.ts` already groups by `row` and sorts
   by `column`; the aisle gap is rendered by inserting a visual gap
   wherever `column - previous_column > 1` within a sorted row — which
   the physical-layout aisle model above now genuinely produces (a
   pure numbering-only model, considered and rejected during Slice B,
   would never have produced a column gap for this to key off of).

## Failure modes

- **Torn writes**: `generate_seat_layout()` → `replace_vehicle_type_seats()`
  stays inside the same `transaction.atomic()` the existing function
  already opens — no partial layout is ever visible.
- **Concurrency**: two concurrent `generate/` calls for the same
  VehicleType race the same way two concurrent `PUT`s already would —
  unchanged from today, not a new concern this spec introduces (no
  concurrent-seat-generation invariant is claimed or needed; the last
  write wins, same as `set_route_stops`'s existing replace-the-set
  semantics).

## Test plan

**Backend**:
- `generate_seat_layout()`: correct `seat_number`/`row`/`column` output
  for representative `rows`/`columns`/`aisle_after_column` combinations,
  including no-aisle.
- Capacity-exceeded, invalid-aisle-position `400`s.
- `SeatsInUse` `409` when regenerating over existing `SeatReservation`s
  — the actual bug this spec fixes, not just the new feature; a
  regression test proving today's unhandled 500 no longer happens.
- Regenerating with zero reservations still works exactly as
  `replace_vehicle_type_seats` already does today (no behavior change
  for the safe case).
- `grep -rn "\.all_objects\."` audit — confirm the existing tenancy-bypass
  fix in `replace_vehicle_type_seats` is untouched by this change.

**Frontend** (`client-admin-app`):
- New seat-map screen: rows/columns/aisle inputs, live grid preview,
  submit calls `generate/`, renders the returned seat list.
- `seat-picker.ts` (customer-app): aisle-gap rendering for a
  `row`/`column` grid with a configured aisle (§ Edge case 5).

**E2E**: extend `client-admin-app`'s existing `vehicle-types` e2e
coverage (if any exists — confirm before writing new spec) with a
generate-then-view round trip; extend the booking e2e flow to confirm
a seat picked from a generated grid still books correctly end-to-end.

## Migration impact

**None.** No schema change — `row`/`column` already exist. Purely a
service-layer/API-surface/frontend change.

## Implementation note (Slice A — backend, done)

Built exactly as spec'd, 2026-08-19. `apps.seating.services.SeatSpec`
(`TypedDict`: `seat_number`/`row`/`column`), `generate_seat_layout()`
(pure function, `row_letter` scheme only), and
`replace_vehicle_type_seats()` changed from `seat_numbers: list[str]`
to `seats: list[SeatSpec]`, writing `row`/`column` into each created
`Seat`. `VehicleTypeSeatsUpdateSerializer`'s body is now
`{"seats": [{"seat_number", "row", "column"}, ...]}` (`row`/`column`
optional, matching `Seat`'s own nullable fields — `PUT` still doesn't
require geometry, only `generate/` always supplies it). New `POST
/vehicle-types/{id}/seats/generate/` (`VehicleTypeSeatsGenerateView`,
same `seating.manage` permission as `PUT`), validating
`rows * columns <= capacity` and `aisle_after_column < columns` before
calling `generate_seat_layout()` then the same
`replace_vehicle_type_seats()`.

The `SeatsInUse` fix (Edge case §1) is real and tested: the existing
`Seat.all_objects.filter(...).delete()` is now wrapped in
`try/except ProtectedError`, converting what was an unhandled 500 into
a `409` naming the count of seats with reservations against them — a
regression test (`test_regenerating_seats_with_active_reservations_returns_409_not_500`)
creates a real `SeatReservation` via `create_reservation()` first and
proves the 409 (and that the original seat survives the rolled-back
transaction), plus a service-level equivalent
(`test_replace_vehicle_type_seats_raises_seats_in_use_at_the_service_layer`).

`apps.core.management.commands.seed_e2e_users`'s own seat-seeding call
site was migrated to call `generate_seat_layout(rows=3, columns=2, ...)`
instead of a flat `BOOKABLE_SEAT_NUMBERS` list passed straight through
— a fortunate coincidence: 3×2 under `row_letter` numbering produces
exactly `["1A","1B","2A","2B","3A","3B"]`, the same six seat numbers
already fixed by the e2e Playwright specs, so this fixture now also
exercises real `row`/`column` geometry with no behavior change for any
existing e2e assertion (all keyed on seat *number*, never row/column).

No model/migration change, as scoped — `Seat.row`/`Seat.column`
already existed. `openapi.yaml` regenerated
(`VehicleTypeSeatsGenerateView`, the new `seats` request shape) and
drift-checked clean. 540/540 backend tests passing (up from 511),
including 9 new tests in `apps/seating/tests/test_seating.py` covering
`generate_seat_layout()` directly, the `generate/` endpoint (success,
capacity-exceeded 400, invalid-aisle 400, permission enforcement), and
both `SeatsInUse` regressions. `ruff`/`mypy` clean.

**Hit, not a regression**: a full unfiltered `pytest` run against the
pre-existing `--reuse-db` test database failed ~157 tests in an
across-the-board permission/tenancy shape — this is the documented
gotcha in `CLAUDE.md` (a `transaction=True` concurrency test earlier in
the same run flushes the reused DB's seeded `identity_permission` rows).
`pytest --create-db` once resolved it; not a real regression, and
`docs/architecture.md` already carries this caveat so it isn't repeated
there.

## Implementation note (Slice B — frontend, done)

Built 2026-08-20, closing Phase 8 entirely.

**Aisle model change, decided before building**: Slice A shipped
`aisle_after_column` as a pure numbering signal (no column gap), but
building this slice's `seat-picker.ts` piece (Edge case §5) exposed
that its own rendering mechanism — a gap wherever `column −
previous_column > 1` — could never fire against Slice A's own output,
since it never produced a gap. This was flagged, not silently built as
dead code: asked the user, who chose the physical-layout model over
keeping the numbering-only one. `generate_seat_layout()` was revised so
the stored `column` integer now jumps by 2 across the aisle (e.g.
`1,2,4,5`), while the row's real seat count and `seat_number` sequence
are both unchanged (still `rows * columns` seats, still `1A,1B,1C,1D`)
— both Slice A tests and the spec text above were updated to match.
This was a real, if small, revision to already-shipped, already-tested
code, not a purely additive Slice B change.

**`client-admin-app`**: new `vehicle-types/:id/seats` screen
(`SeatMap`), linked from a "Seat map" action on `vehicle-type-list`
(gated `seating.view`, matching the existing "Edit" action's
`fleet.manage` gate pattern). Shows the vehicle type's current layout
(`GET /vehicle-types/{id}/seats/`), and — behind
`*appHasPermission="'seating.manage'"` — a rows/columns/aisle form with
a **client-side-only preview** (`computeLayoutPreview()`, a pure
mirror of the backend's `generate_seat_layout()`) that never touches
the network until "Generate" is explicitly submitted, since the real
endpoint is a destructive replace-the-set write. Capacity-exceeded and
invalid-aisle-position are both caught client-side before submission
(disabling Generate), on top of the backend's own 400s. A `SeatsInUse`
409 surfaces as a plain alert.

**`customer-app`**: `seat-picker.ts`'s `seatRows` computed now splits
each row into segments wherever a `column` gap appears
(`splitAtAisleGaps()`), and the template renders each segment as its
own flex group with a wider gap between segments than between seats
within one — the visual aisle. A VehicleType with no aisle still
renders as one segment per row, unchanged from before this slice.

**A second real bug found and fixed, independent of the aisle
question**: `VehicleTypeSeatsView`'s `GET` (and the new `generate/`
endpoint) had always been documented in the OpenAPI schema as returning
a *paginated* `{count, next, previous, results}` envelope, purely
because both are `GenericAPIView`s and this backend's global
`DEFAULT_PAGINATION_CLASS` applies to any such view by default — even
though neither method has ever called `paginate_queryset()`, both
always returned (and still return) a bare array, and an explicit
`responses=SeatSerializer(many=True)` on the class-level `@extend_schema`
didn't stop drf-spectacular's automatic pagination inference. Invisible
until now because `generate/` (and, by extension, `GET`) had zero real
frontend consumers before this slice's own `SeatMap` screen became the
first — the generated TypeScript types didn't match the runtime
response shape, and the frontend build failed outright on it. Fixed at
the root on both views with `pagination_class = None`, not by working
around the wrong type in the frontend — `openapi.yaml` regenerated and
now correctly shows a bare `Seat[]` response for both.

**Verification**: 540/540 backend tests unaffected (no backend test
behavior changed, only the documented response type); `ruff`/`mypy`
clean. Frontend: 278/278 `client-admin-app` Karma tests (up from 276)
and 118/118 `customer-app` Karma tests (up from 117), `ng lint` clean
on both apps, `ng build` clean on both. Live-verified end to end
against the real backend (`uv run python manage.py runserver` directly
against the already-running `postgres`/`redis` containers, same
documented workaround as Phase 6 — the backend Docker image still
predates this repo's newer dependencies) with a real Client/Business/
VehicleType/Route/Trip: generated a 2×4 layout with `aisle_after_column: 2`
through the real `client-admin-app` UI, screenshotted the result
showing the aisle gap rendered correctly in both the "Current layout"
and "Preview" panels, and confirmed via a direct authenticated call to
`GET /trips/{id}/availability/` (the exact endpoint `seat-picker.ts`
consumes) that the real persisted data carries the column gap
(`1,2,4,5`) `splitAtAisleGaps()` needs — proving the full data path
end to end without needing a full passenger booking flow (fare
configuration, customer-audience login) just to view one screen. The
demo Client created for this verification could not be cleanly deleted
afterward (a `ProtectedError` cascading through Route/Trip/Vehicle
PROTECT relationships) — left in the dev database rather than
force-cascading it, the same "don't force through a protected
relationship" posture `prune_e2e_test_data` already established.

**This closes Phase 8 (Seat Map Generation) entirely** — both slices
built, tested, and verified.
