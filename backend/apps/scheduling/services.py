"""Fat-service layer for Schedule/Trip management — mirrors
apps.network.services's shape (see
docs/specs/3-network-scheduling-fleet.md §4). Cross-business validation
for `vehicle`/`driver` (must belong to the same Business as the Trip) is
already enforced by the serializers
(`TripCreateSerializer`/`TripAssignmentSerializer`) before any of this
is called — services here assume pre-validated input, matching
apps.fleet.services's own documented convention.
"""

from datetime import UTC, date, datetime, time
from typing import Any
from zoneinfo import ZoneInfo

from django.db import transaction
from django.utils import timezone

from apps.businesses.models import Business
from apps.core.audit import record_audit_event
from apps.core.rls import platform_staff_bypass
from apps.fleet.models import Driver, Vehicle
from apps.identity.models import User
from apps.network.models import Route

from .models import Schedule, Trip

# Legal Trip status transitions (see docs/specs/3-network-scheduling-fleet.md
# §2). A request to a Trip's own current status is an idempotent no-op,
# handled separately in transition_trip_status — not represented here.
TRIP_TRANSITIONS: dict[str, set[str]] = {
    Trip.Status.SCHEDULED: {Trip.Status.IN_PROGRESS, Trip.Status.CANCELLED},
    Trip.Status.IN_PROGRESS: {Trip.Status.COMPLETED, Trip.Status.CANCELLED},
    Trip.Status.COMPLETED: set(),
    Trip.Status.CANCELLED: set(),
}


class TripNotBookable(Exception):
    """Raised by `resolve_bookable_trip_across_clients` when the four
    forced predicates don't all hold — mapped to a 404 by the view layer,
    indistinguishable from "doesn't exist" (same posture as every other
    not-found-vs-not-authorized case in this codebase)."""


class TripClassNotAvailableOnRoute(Exception):
    """The class isn't in the Route's `available_trip_classes` allow-list
    — docs/specs/15-trip-classes.md. Mapped to a 400."""


class TripClassLocked(Exception):
    """`Trip.trip_class` cannot change once anything non-cancelled is
    sold for that Trip. Mapped to a 409.

    Changing it would silently change what a passenger already paid
    for, and the price they were charged is snapshotted on their
    `SeatReservation` against a rule for the *old* class — so the
    booking would no longer be explainable by any rule the system could
    still find.
    """


class VehicleClassMismatch(Exception):
    """The Vehicle's `vehicle_type.trip_class` differs from the Trip's.
    Mapped to a 400.

    A hard rejection, not a warning: selling Premium and running a Mini
    is a refund event, and this system has no refund service — spec 10's
    own `trip.oversold` note records that an audit record nobody can act
    on is not a control. Better to block it at assignment.
    """


def _check_class_allowed_on_route(route: Route, trip_class: str) -> None:
    """An **empty** allow-list means no restriction, not "nothing
    allowed" — that is what keeps every Route that predates spec 15
    working untouched."""
    allowed = route.available_trip_classes or []
    if allowed and trip_class not in allowed:
        raise TripClassNotAvailableOnRoute(
            f"Route {route.name} does not offer {trip_class} services."
        )


def _check_vehicle_class_matches(vehicle: Vehicle | None, trip_class: str) -> None:
    """Unassignment (`vehicle=None`) is always allowed — the class
    belongs to the Trip, not to whatever is currently running it."""
    if vehicle is None:
        return
    vehicle_class = vehicle.vehicle_type.trip_class
    if vehicle_class != trip_class:
        raise VehicleClassMismatch(
            f"This is a {trip_class} service and {vehicle.registration_number} "
            f"is a {vehicle_class} vehicle."
        )


def compute_scheduled_departure_at(
    business: Business, service_date: date, departure_time: time
) -> datetime:
    """Localizes service_date+departure_time in the Business's own
    timezone, converts to UTC. Shared by create_manual_trip() and
    generate_trips_for_schedule() so the two Trip-creation paths can
    never disagree on this arithmetic. Raises
    zoneinfo.ZoneInfoNotFoundError for an invalid business.timezone —
    callers decide how to handle that (the generation task catches it
    per-Schedule; a manual Trip creation lets it surface as a 500, same
    posture as any other malformed stored config value)."""
    local_dt = datetime.combine(service_date, departure_time, tzinfo=ZoneInfo(business.timezone))
    return local_dt.astimezone(UTC)


def create_schedule(
    *,
    route: Route,
    days_of_week: list[int],
    departure_time: time,
    effective_from: date,
    effective_until: date | None,
    created_by: User,
    trip_class: str = Business.TripClass.STANDARD,
) -> Schedule:
    business = route.business
    _check_class_allowed_on_route(route, trip_class)
    schedule = Schedule.objects.create(
        client=business.client,
        route=route,
        business=business,
        days_of_week=days_of_week,
        departure_time=departure_time,
        effective_from=effective_from,
        effective_until=effective_until,
        trip_class=trip_class,
    )
    record_audit_event(actor=created_by, action="schedule.created", target=schedule)
    return schedule


def update_schedule(*, schedule: Schedule, updated_by: User, **fields: Any) -> Schedule:
    """If days_of_week narrows, effective_until shrinks below an
    already-generated future date, or is_active flips False: cascades to
    cancel future not-yet-departed Trips that no longer match (§6's
    DECISION). Wraps the read+cancel loop in select_for_update(), same
    precedent as apps.businesses.services.decide_business_kyb, to avoid a
    lost-update race between two concurrent edits producing an
    inconsistent cancellation set."""
    with transaction.atomic():
        schedule = Schedule.all_objects.select_for_update().get(pk=schedule.pk)
        if "trip_class" in fields:
            _check_class_allowed_on_route(schedule.route, fields["trip_class"])
        previous_days = set(schedule.days_of_week)
        previous_effective_until = schedule.effective_until
        previous_is_active = schedule.is_active

        for field, value in fields.items():
            setattr(schedule, field, value)
        schedule.save(update_fields=list(fields))

        narrowed_days = "days_of_week" in fields and not previous_days <= set(
            fields["days_of_week"]
        )
        shrunk_effective_until = (
            "effective_until" in fields
            and fields["effective_until"] is not None
            and (
                previous_effective_until is None
                or fields["effective_until"] < previous_effective_until
            )
        )
        deactivated = "is_active" in fields and previous_is_active and not fields["is_active"]

        if narrowed_days or shrunk_effective_until or deactivated:
            reason = "Schedule deactivated" if deactivated else "Schedule updated"
            _cancel_future_trips_for_schedule(schedule, reason=reason, actor=updated_by)

    record_audit_event(actor=updated_by, action="schedule.updated", target=schedule, **fields)
    return schedule


def _cancel_future_trips_for_schedule(schedule: Schedule, reason: str, actor: User) -> None:
    """Finds Trips for this schedule with status=scheduled and
    service_date >= today-in-business-timezone whose date no longer
    matches the current pattern (or all of them, if is_active=False —
    the caller already applied that field before calling this), and
    calls transition_trip_status() on each so every cancellation gets
    its own real trip.status_changed audit row with the actual acting
    staff member as actor. Never touches in_progress/completed Trips."""
    today_local = datetime.now(ZoneInfo(schedule.business.timezone)).date()
    candidates = Trip.all_objects.filter(
        schedule=schedule, status=Trip.Status.SCHEDULED, service_date__gte=today_local
    )
    if not schedule.is_active:
        to_cancel = list(candidates)
    else:
        to_cancel = [
            trip
            for trip in candidates
            if trip.service_date.isoweekday() not in schedule.days_of_week
            or trip.service_date < schedule.effective_from
            or (
                schedule.effective_until is not None
                and trip.service_date > schedule.effective_until
            )
        ]
    for trip in to_cancel:
        transition_trip_status(
            trip=trip, new_status=Trip.Status.CANCELLED, reason=reason, actor=actor
        )


def create_manual_trip(
    *,
    route: Route,
    service_date: date,
    departure_time: time,
    vehicle: Vehicle | None,
    driver: Driver | None,
    created_by: User,
    trip_class: str = Business.TripClass.STANDARD,
) -> Trip:
    """schedule=None always. booking_mode and fare_collection_mode are
    both snapshotted from the Business at creation time — later changes
    to either default only affect future Trips.

    `trip_class` comes from the request rather than from the Business,
    because unlike those two it is a per-departure decision, not a
    Business-wide default.
    """
    business = route.business
    _check_class_allowed_on_route(route, trip_class)
    _check_vehicle_class_matches(vehicle, trip_class)
    trip = Trip.objects.create(
        client=business.client,
        schedule=None,
        route=route,
        business=business,
        service_date=service_date,
        scheduled_departure_at=compute_scheduled_departure_at(
            business, service_date, departure_time
        ),
        status=Trip.Status.SCHEDULED,
        vehicle=vehicle,
        driver=driver,
        booking_mode=business.booking_mode_default,
        fare_collection_mode=business.fare_collection_mode,
        trip_class=trip_class,
    )
    record_audit_event(actor=created_by, action="trip.created", target=trip)
    return trip


def assign_trip_resources(
    *, trip: Trip, vehicle: Vehicle | None, driver: Driver | None, updated_by: User
) -> Trip:
    _check_vehicle_class_matches(vehicle, trip.trip_class)
    trip.vehicle = vehicle
    trip.driver = driver
    trip.save(update_fields=["vehicle", "driver"])
    record_audit_event(
        actor=updated_by,
        action="trip.assignment_updated",
        target=trip,
        vehicle_id=str(vehicle.id) if vehicle else None,
        driver_id=str(driver.id) if driver else None,
    )
    return trip


def set_trip_class(*, trip: Trip, trip_class: str, updated_by: User) -> Trip:
    """Change a Trip's class, but only while nothing is sold —
    docs/specs/15-trip-classes.md.

    Its own service function and its own endpoint rather than a field on
    the assignment PATCH: `TripAssignmentSerializer`'s `vehicle` and
    `driver` both default to `None` and therefore *clear* on omission,
    and a guarded field sharing a body with two clear-on-omit fields is
    a trap — a class edit that forgot to resend the vehicle would
    silently unassign it.

    A `pending_payment` Booking counts as sold: a held seat is a live
    offer at a quoted price. Only `cancelled` and `expired` Bookings
    leave the class free to move, because nothing survives them.

    Also re-checks the route allow-list and the assigned vehicle, so
    this path cannot reach a state `create_manual_trip` would have
    refused.
    """
    # Local import — apps.booking imports Trip from this app, so a
    # module-level import back would be circular. Same shape
    # apps.seating.services already uses for apps.ticketing.capacity.
    from apps.booking.models import Booking

    with transaction.atomic():
        locked = Trip.all_objects.select_for_update().get(pk=trip.pk)
        if locked.trip_class == trip_class:
            # Idempotent no-op, matching transition_trip_status's own
            # handling of a request to the current value: no audit row,
            # and — importantly — no rejection, so re-sending the class
            # a sold Trip already has does not 409.
            return locked

        sold = (
            Booking.all_objects.filter(trip=locked, deleted_at__isnull=True)
            .exclude(status__in=[Booking.Status.CANCELLED, Booking.Status.EXPIRED])
            .exists()
        )
        if sold:
            raise TripClassLocked(
                "This trip already has bookings, so its class can no longer be changed."
            )

        _check_class_allowed_on_route(locked.route, trip_class)
        _check_vehicle_class_matches(locked.vehicle, trip_class)

        previous = locked.trip_class
        locked.trip_class = trip_class
        locked.save(update_fields=["trip_class"])

    record_audit_event(
        actor=updated_by,
        action="trip.class_changed",
        target=locked,
        previous_trip_class=previous,
        trip_class=trip_class,
    )
    return locked


def transition_trip_status(*, trip: Trip, new_status: str, reason: str, actor: User) -> Trip:
    """Trusts the caller (TripStatusSerializer.validate(), or
    _cancel_future_trips_for_schedule() above) to have already checked
    the transition is legal per TRIP_TRANSITIONS and that a reason is
    present when cancelling — same pre-validated-input convention as the
    rest of this module. A request to the Trip's own current status is
    an idempotent no-op: returns the Trip unchanged, no audit row.

    Also the **sole** writer of `Trip.status` anywhere in this backend,
    which is what makes it the right place to stamp the actual
    departure/arrival times docs/specs/16-operational-analytics.md needs
    — `status_changed_at` alone cannot answer "when did this Trip
    depart" once it has since completed, because every transition
    overwrites it.
    """
    if new_status == trip.status:
        return trip
    now = timezone.now()
    trip.status = new_status
    trip.status_changed_at = now
    # Stamped only when still null, so a transition cannot rewrite a
    # time that already happened. TRIP_TRANSITIONS makes returning to a
    # status unreachable through the API today, but this function trusts
    # its caller to have checked that — and an analytics field that a
    # future caller could silently falsify is worse than one that is
    # occasionally stale.
    if new_status == Trip.Status.IN_PROGRESS and trip.actual_departure_at is None:
        trip.actual_departure_at = now
    if new_status == Trip.Status.COMPLETED and trip.actual_arrival_at is None:
        trip.actual_arrival_at = now
    if new_status == Trip.Status.CANCELLED:
        trip.cancellation_reason = reason
    trip.save(
        update_fields=[
            "status",
            "status_changed_at",
            "actual_departure_at",
            "actual_arrival_at",
            "cancellation_reason",
        ]
    )
    record_audit_event(
        actor=actor, action="trip.status_changed", target=trip, status=new_status, reason=reason
    )
    return trip


def resolve_bookable_trip_across_clients(*, trip_id: str) -> Trip:
    """The one place `apps.marketplace`'s views resolve a single Trip —
    docs/adr/0009, docs/specs/22-marketplace.md. Used by both seat
    availability and booking creation, so these four checks live in
    exactly one place rather than being re-derived (and potentially
    drifting) per call site.

    `Trip.all_objects`, since a marketplace passenger's own Client is
    never the one that owns the Trip being booked. Every one of the four
    predicates below is forced, first-class, and asserted fresh here —
    none of them is "already true" the way it incidentally was under
    RLS's own Client-scoping (see docs/adr/0009's own findings:
    `TripAvailabilityView` doesn't independently check `status` today,
    and Business KYB approval is only ever enforced at write time).

    Also needs `platform_staff_bypass()`, not just `all_objects` — RLS
    applies regardless of manager, so without it this would silently see
    nothing for a genuinely cross-Client Trip. See
    `apps.network.services.find_route_stop_matches_across_clients`'s own
    docstring for the identical reasoning; this is that same, deliberate
    first passenger-facing use of the bypass.
    """
    with platform_staff_bypass():
        trip = (
            Trip.all_objects.select_related("route", "business", "vehicle__vehicle_type")
            .filter(
                id=trip_id,
                status=Trip.Status.SCHEDULED,
                fare_collection_mode=Business.FareCollectionMode.PREPAID,
                route__status=Route.Status.ACTIVE,
                business__kyb_status=Business.KybStatus.APPROVED,
            )
            .first()
        )
    if trip is None:
        raise TripNotBookable(f"Trip {trip_id} is not bookable on the marketplace.")
    return trip
