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
) -> Schedule:
    business = route.business
    schedule = Schedule.objects.create(
        client=business.client,
        route=route,
        business=business,
        days_of_week=days_of_week,
        departure_time=departure_time,
        effective_from=effective_from,
        effective_until=effective_until,
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
) -> Trip:
    """schedule=None always. booking_mode snapshotted from
    route.business.booking_mode_default at creation time — later changes
    to the Business's default only affect future Trips."""
    business = route.business
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
    )
    record_audit_event(actor=created_by, action="trip.created", target=trip)
    return trip


def assign_trip_resources(
    *, trip: Trip, vehicle: Vehicle | None, driver: Driver | None, updated_by: User
) -> Trip:
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


def transition_trip_status(*, trip: Trip, new_status: str, reason: str, actor: User) -> Trip:
    """Trusts the caller (TripStatusSerializer.validate(), or
    _cancel_future_trips_for_schedule() above) to have already checked
    the transition is legal per TRIP_TRANSITIONS and that a reason is
    present when cancelling — same pre-validated-input convention as the
    rest of this module. A request to the Trip's own current status is
    an idempotent no-op: returns the Trip unchanged, no audit row."""
    if new_status == trip.status:
        return trip
    trip.status = new_status
    trip.status_changed_at = timezone.now()
    if new_status == Trip.Status.CANCELLED:
        trip.cancellation_reason = reason
    trip.save(update_fields=["status", "status_changed_at", "cancellation_reason"])
    record_audit_event(
        actor=actor, action="trip.status_changed", target=trip, status=new_status, reason=reason
    )
    return trip
