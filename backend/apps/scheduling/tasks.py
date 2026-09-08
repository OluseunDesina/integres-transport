"""Celery Beat generation job — see
docs/specs/3-network-scheduling-fleet.md §4. Runs daily (registered via
a data migration seeding a django_celery_beat CrontabSchedule +
PeriodicTask, 01:00 UTC), rolling a TRIP_GENERATION_HORIZON_DAYS-day
window of Trip rows forward from each active Schedule. Idempotent:
Trip.all_objects.get_or_create(schedule=, service_date=) plus the DB
UniqueConstraint means re-running for an already-generated date/schedule
pair is a true no-op, safe under partial-failure or concurrent runs.
"""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from celery import shared_task
from django.conf import settings

from apps.core.audit import record_audit_event
from apps.core.rls import platform_staff_bypass

from .models import Schedule, Trip
from .services import compute_scheduled_departure_at


def generate_trips_for_schedule(schedule: Schedule, horizon_days: int) -> list[Trip]:
    """Pure-ish, unit-testable without Celery. 'Today' is evaluated in
    the Schedule's own Business timezone, not server UTC — a Lagos
    Schedule's day boundary isn't the same instant as a Botswana one's.
    Raises zoneinfo.ZoneInfoNotFoundError for an invalid
    business.timezone; the caller (generate_trips) catches this
    per-Schedule so one bad timezone doesn't fail the whole batch."""
    tz = ZoneInfo(schedule.business.timezone)
    today_local = datetime.now(tz).date()
    created: list[Trip] = []
    for offset in range(horizon_days + 1):
        service_date = today_local + timedelta(days=offset)
        if service_date.isoweekday() not in schedule.days_of_week:
            continue
        if service_date < schedule.effective_from:
            continue
        if schedule.effective_until is not None and service_date > schedule.effective_until:
            continue
        trip, was_created = Trip.all_objects.get_or_create(
            schedule=schedule,
            service_date=service_date,
            defaults={
                "client": schedule.client,
                "business": schedule.business,
                "route": schedule.route,
                "scheduled_departure_at": compute_scheduled_departure_at(
                    schedule.business, service_date, schedule.departure_time
                ),
                "booking_mode": schedule.business.booking_mode_default,
                "fare_collection_mode": schedule.business.fare_collection_mode,
                # Snapshotted from the *Schedule*, not the Business —
                # class is a per-service decision, not a Business-wide
                # default. A Schedule edited between two generation runs
                # produces Trips of different classes on different days,
                # which is correct and matches how days_of_week edits
                # already behave (docs/specs/15-trip-classes.md).
                "trip_class": schedule.trip_class,
                "status": Trip.Status.SCHEDULED,
            },
        )
        if was_created:
            created.append(trip)
    return created


@shared_task
def generate_trips() -> None:
    generated = 0
    schedule_count = 0
    skipped_invalid_timezone: list[str] = []
    # A Celery task has no ambient tenancy context or open transaction —
    # per CLAUDE.md, any code touching BaseModel rows outside a request
    # must call apps.core.rls.set_rls_session_vars (here, via
    # platform_staff_bypass) itself, inside an open transaction, or every
    # query/write is silently empty/rejected under RLS.
    with platform_staff_bypass():
        for schedule in Schedule.all_objects.filter(
            is_active=True, deleted_at__isnull=True
        ).select_related("business"):
            schedule_count += 1
            try:
                generated += len(
                    generate_trips_for_schedule(schedule, settings.TRIP_GENERATION_HORIZON_DAYS)
                )
            except ZoneInfoNotFoundError:
                skipped_invalid_timezone.append(str(schedule.id))
        record_audit_event(
            actor=None,
            action="scheduling.trips_generated",
            client_id=None,
            schedule_count=schedule_count,
            trip_count=generated,
            skipped_invalid_timezone=skipped_invalid_timezone,
        )
