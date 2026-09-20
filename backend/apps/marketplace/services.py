"""Fat-service layer for apps.marketplace — docs/adr/0009,
docs/specs/22-marketplace.md. Thin views only in this app; every read/
write below delegates to existing, unmodified domain services
(`apps.fares.services.get_fare`, `apps.booking.services.create_booking`,
...) once a Trip has been resolved as genuinely cross-Client-bookable.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date

from apps.booking.models import Booking
from apps.businesses.models import Business
from apps.core.context import reset_current_client_id, set_current_client_id
from apps.core.rls import platform_staff_bypass
from apps.fares.services import FareNotConfigured, get_fare
from apps.identity.models import User
from apps.network.models import Stop
from apps.network.services import find_route_stop_matches_across_clients
from apps.scheduling.models import Trip
from apps.seating.services import get_bookability


@contextmanager
def as_client(client_id: object) -> Iterator[None]:
    """Temporarily points `TenantScopedManager`'s Python contextvar at
    `client_id` — the second half of the "assume this Trip's own
    operator Client" pattern docs/adr/0009 describes (shape 3). Callers
    are expected to already be inside `platform_staff_bypass()` for the
    Postgres-level half; this only fixes up the ORM-level half, the same
    split `apps.core.management.commands.seed_e2e_users
    ._seed_boardable_open_seating_ticket` already uses to call
    `create_booking` on behalf of a Client other than the ambient one.
    """
    token = set_current_client_id(str(client_id))
    try:
        yield
    finally:
        reset_current_client_id(token)


def search_trips_across_clients(
    *, origin: str, destination: str, service_date: date, trip_class: str | None = None
) -> list[dict[str, object]]:
    """The marketplace's cross-Client variant of
    `apps.scheduling.views.TripSearchView.get`'s own result-building loop
    — identical shape and forced filters (`status=SCHEDULED`,
    `fare_collection_mode=PREPAID`; an unpriced Trip is excluded from the
    list, not shown with no price), except every read here is
    `all_objects` inside `platform_staff_bypass()`, and each Trip's own
    fare lookup runs with the ORM contextvar pointed at *that* Trip's own
    Client (`as_client`) — `get_fare` reads `FareRule`/`FareSegmentRule`
    via `.objects`, unmodified, and would otherwise silently scope to the
    caller's own (Marketplace) Client instead.
    """
    matches = find_route_stop_matches_across_clients(origin=origin, destination=destination)

    results: list[dict[str, object]] = []
    with platform_staff_bypass():
        for match in matches:
            # "business" — TripSearchResultSerializer.get_business_name
            # reads through it; without this it's one extra query per
            # result row, and here that query would also need its own
            # RLS clearance since it's not covered by the bypass above
            # once results are serialized outside this function.
            # "vehicle__vehicle_type" — TripSerializer.get_vehicle reads
            # through it for the same reason.
            trips = Trip.all_objects.select_related(
                "route", "vehicle__vehicle_type", "driver", "business"
            ).filter(
                route=match.route,
                service_date=service_date,
                status=Trip.Status.SCHEDULED,
                fare_collection_mode=Business.FareCollectionMode.PREPAID,
            )
            if trip_class is not None:
                trips = trips.filter(trip_class=trip_class)
            for trip in trips:
                with as_client(trip.client_id):
                    try:
                        quote = get_fare(
                            trip=trip, from_stop=match.from_stop, to_stop=match.to_stop
                        )
                    except FareNotConfigured:
                        continue
                    bookability = get_bookability(
                        trip=trip, from_stop=match.from_stop, to_stop=match.to_stop
                    )
                results.append(
                    {
                        "trip": trip,
                        "from_stop": match.from_stop,
                        "to_stop": match.to_stop,
                        "stops_between": match.stops_between,
                        "fare": {"amount": quote.amount, "currency": quote.currency},
                        "capacity_remaining": bookability.capacity_remaining,
                    }
                )
    return results


def resolve_own_booking_across_clients(*, booking_id: str, passenger: User) -> Booking | None:
    """The "my own already-created record" shape (docs/adr/0009, shape
    2) applied to one Booking rather than a whole list —
    `apps.marketplace.views.MarketplacePaymentIntentCreateView`'s own
    use of it. `passenger=passenger` is the sole authorization check,
    same as the widened `BookingMineView`; `platform_staff_bypass()` is
    still required for RLS, `all_objects` alone does not reach it.
    Returns `None` rather than raising — the view maps that to 404,
    indistinguishable from "doesn't exist" for a booking that is not
    this passenger's own, same posture as everywhere else in this
    codebase.
    """
    with platform_staff_bypass():
        return (
            Booking.all_objects.select_related("trip", "business")
            .filter(id=booking_id, passenger=passenger, deleted_at__isnull=True)
            .first()
        )


def suggest_stops_across_clients(*, q: str, limit: int) -> list[Stop]:
    """The marketplace's cross-Client variant of
    `apps.network.views.StopSuggestView.get_queryset` — identical
    dedup-by-name logic, `all_objects` instead of `.objects`, plus the
    `business__kyb_status=APPROVED` predicate `find_route_stop_matches_
    across_clients` also needs and for the same reason (docs/adr/0009).

    Returns a materialized list, not a lazy queryset: RLS (not just the
    ORM filter) must still be open when this actually executes, so the
    query has to run — and finish — inside `platform_staff_bypass()`
    here, not whenever the view's own pagination/serialization happens
    to iterate it later.
    """
    with platform_staff_bypass():
        queryset = Stop.all_objects.filter(
            is_active=True, business__kyb_status=Business.KybStatus.APPROVED
        )
        if q:
            queryset = queryset.filter(name__icontains=q)
        return list(queryset.order_by("name").distinct("name")[:limit])
