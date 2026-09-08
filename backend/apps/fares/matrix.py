"""The stop-pair fare matrix — docs/specs/12-fare-matrix.md.

A read and a bulk write over `FareSegmentRule` rows that already exist
and are already versioned. **Nothing here writes a `FareSegmentRule`
directly.** Every mutation goes through `apps.fares.services`, which
owns the close-and-supersede dance that keeps the half-open
`[effective_from, effective_to)` timeline gapless and satisfies the
GiST exclusion constraint. A grid that updated `amount` in place would
silently destroy the price snapshot a historical `SeatReservation`
still points at — the whole reason fares are versioned at all.

This module is the orchestrator that layer needs, kept out of
`services.py` because it is a different kind of thing: `services.py`
functions each own one rule's lifecycle, while these two own a whole
route's grid and coordinate many of those calls inside one transaction.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.businesses.models import Business
from apps.identity.models import User
from apps.network.models import Route, RouteStop, Stop

from .models import ANY_TRIP_CLASS, FareSegmentRule
from .services import (
    # Module-private in `services`, imported here rather than
    # reimplemented: the half-open `[effective_from, effective_to)`
    # window rule must be identical to the one `get_fare()` applies, or
    # the grid would show a price booking does not charge.
    _effective_at_filter,
    close_fare_segment_rule,
    create_fare_segment_rule,
    supersede_fare_segment_rule,
)


class FarePricingModeMismatch(Exception):
    """The Business prices flat, so per-segment rules would be written
    and then never read — `get_fare()` picks the rule *type* from
    `business.fare_pricing_mode` at lookup time. Silently accepting them
    is the worst of the available outcomes, so this is a hard refusal
    pointing at the Business setting."""


class UnknownSegment(Exception):
    """A submitted (from_stop, to_stop) pair is not a forward pair on
    this route's *current* stop list.

    Usually means the route was reordered between the grid being loaded
    and saved — `set_route_stops` hard-deletes and recreates `RouteStop`
    rows, so a concurrent edit can invalidate a pair mid-flight. The
    whole submission is rejected naming the offending pairs, rather than
    dropping them: an operator who believed they had priced a segment
    and had it silently discarded would only find out at booking time,
    as `FareNotConfigured`.
    """

    def __init__(self, pairs: list[tuple[str, str]]) -> None:
        self.pairs = pairs
        super().__init__(
            "These segments are not forward stop pairs on this route: "
            + ", ".join(f"{f} -> {t}" for f, t in pairs)
        )


@dataclass(frozen=True)
class MatrixCell:
    from_stop: Stop
    to_stop: Stop
    amount: Decimal | None
    fare_segment_rule: FareSegmentRule | None


@dataclass(frozen=True)
class FareMatrix:
    route: Route
    business: Business
    # Which class's grid this is. `""` (ANY_TRIP_CLASS) is the wildcard
    # grid — the prices that apply to any class with no grid of its own,
    # and the only grid that existed before spec 15.
    trip_class: str
    stops: list[Stop]
    cells: list[MatrixCell]


def _ordered_stops(route: Route) -> list[tuple[int, Stop]]:
    """The route's stops in sequence order, as `(sequence, stop)`.

    Read through `RouteStop.objects` (the tenant-scoped manager) exactly
    like `RouteSerializer.get_stops` does — not `all_objects`, since
    every caller here is a real, tenant-scoped staff request.
    """
    route_stops = (
        RouteStop.objects.filter(route=route).select_related("stop").order_by("sequence")
    )
    return [(rs.sequence, rs.stop) for rs in route_stops]


def _current_rules(
    route: Route, *, as_of: datetime, trip_class: str
) -> dict[tuple[str, str], FareSegmentRule]:
    """Currently-effective segment rules for the route **in one class**,
    keyed by `(from_stop_id, to_stop_id)`. One query, not one per cell —
    a 30-stop route is 435 pairs.

    Filters `trip_class` exactly rather than falling back to the
    wildcard the way `get_fare()` does, and the difference is the point:
    `get_fare()` answers "what does this passenger pay", where inheriting
    the wildcard is correct, while this answers "what is set on *this*
    grid", where inheriting it would make a wildcard price look like a
    price this class owns — and a save would then supersede a rule the
    operator never meant to touch.
    """
    rules = FareSegmentRule.objects.filter(
        _effective_at_filter(as_of=as_of), route=route, trip_class=trip_class
    )
    return {(str(rule.from_stop_id), str(rule.to_stop_id)): rule for rule in rules}


def get_fare_matrix(
    *, route: Route, trip_class: str = ANY_TRIP_CLASS, as_of: datetime | None = None
) -> FareMatrix:
    """The route's ordered stops plus the effective amount for every
    valid forward pair **in one class**, `None` where unpriced.

    **Forward pairs only** (`to.sequence > from.sequence`) — the same
    rule `BookingCreateSerializer.validate()` enforces as
    `invalid_segment_order`. Emitting the full square would invite
    pricing a segment nobody can book.
    """
    moment = as_of if as_of is not None else timezone.now()
    ordered = _ordered_stops(route)
    rules = _current_rules(route, as_of=moment, trip_class=trip_class)

    cells: list[MatrixCell] = []
    for i, (_, from_stop) in enumerate(ordered):
        for _, to_stop in ordered[i + 1 :]:
            rule = rules.get((str(from_stop.id), str(to_stop.id)))
            cells.append(
                MatrixCell(
                    from_stop=from_stop,
                    to_stop=to_stop,
                    amount=rule.amount if rule else None,
                    fare_segment_rule=rule,
                )
            )

    return FareMatrix(
        route=route,
        business=route.business,
        trip_class=trip_class,
        stops=[stop for _, stop in ordered],
        cells=cells,
    )


@dataclass(frozen=True)
class MatrixSaveResult:
    created: int
    superseded: int
    closed: int
    unchanged: int


def save_fare_matrix(
    *,
    route: Route,
    cells: list[dict[str, Any]],
    updated_by: User,
    trip_class: str = ANY_TRIP_CLASS,
    effective_from: datetime | None = None,
) -> MatrixSaveResult:
    """Bulk-upsert a whole route's matrix **for one class** in **one
    transaction**.

    Writes touch only `trip_class`'s own rules. Another class's grid —
    and the wildcard grid every class falls back to — is left exactly as
    it was, which is the whole reason the class is a required parameter
    on the endpoint rather than an optional one defaulting to the
    wildcard.

    A partly-priced route is worse than a rejected edit: it produces
    `FareNotConfigured` at booking time on exactly the segments the
    operator believed they had just priced. So either every cell lands
    or none does.

    `effective_from` is **one instant for the whole submission**, not
    per cell, so a matrix save is a single coherent price change rather
    than N timelines drifting apart by milliseconds.

    Unchanged cells are skipped entirely — no successor row, no audit
    event. Without that, saving a one-cell edit would churn the version
    history of all 45 pairs on a 10-stop route and bury the real change
    in 45 audit rows.

    Each `cells` entry is `{"from_stop": Stop, "to_stop": Stop,
    "amount": Decimal | None}`; a `None` amount means "stop selling this
    segment" and closes the rule with no successor.
    """
    business = route.business
    if business.fare_pricing_mode != Business.FarePricingMode.PER_SEGMENT:
        raise FarePricingModeMismatch(
            "This business prices fares flat, so per-segment fares would be saved and "
            "then never used. Switch its fare pricing mode to per-segment first."
        )

    moment = effective_from if effective_from is not None else timezone.now()

    ordered = _ordered_stops(route)
    sequence_by_stop = {str(stop.id): sequence for sequence, stop in ordered}
    unknown: list[tuple[str, str]] = []
    for cell in cells:
        from_seq = sequence_by_stop.get(str(cell["from_stop"].id))
        to_seq = sequence_by_stop.get(str(cell["to_stop"].id))
        if from_seq is None or to_seq is None or to_seq <= from_seq:
            unknown.append((cell["from_stop"].name, cell["to_stop"].name))
    if unknown:
        raise UnknownSegment(unknown)

    created = superseded = closed = unchanged = 0

    # One atomic block around every service call. The service functions
    # each open their own `transaction.atomic()`, which nests as a
    # savepoint inside this one rather than committing independently.
    with transaction.atomic():
        existing = _current_rules(route, as_of=moment, trip_class=trip_class)
        for cell in cells:
            key = (str(cell["from_stop"].id), str(cell["to_stop"].id))
            rule = existing.get(key)
            amount: Decimal | None = cell["amount"]

            if rule is None:
                if amount is None:
                    # Blanking an already-unpriced cell is a no-op, not
                    # an error — the grid submits every cell it rendered.
                    unchanged += 1
                    continue
                create_fare_segment_rule(
                    business=business,
                    route=route,
                    from_stop=cell["from_stop"],
                    to_stop=cell["to_stop"],
                    amount=amount,
                    created_by=updated_by,
                    trip_class=trip_class,
                    effective_from=moment,
                )
                created += 1
                continue

            if amount is None:
                close_fare_segment_rule(
                    fare_segment_rule=rule, updated_by=updated_by, effective_to=moment
                )
                closed += 1
                continue

            if amount == rule.amount:
                unchanged += 1
                continue

            supersede_fare_segment_rule(
                fare_segment_rule=rule,
                amount=amount,
                updated_by=updated_by,
                effective_from=moment,
            )
            superseded += 1

    return MatrixSaveResult(
        created=created, superseded=superseded, closed=closed, unchanged=unchanged
    )
