import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pytest

from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import ClientStaffUserFactory

from ..models import Schedule, Trip
from ..services import update_schedule
from ..tasks import generate_trips, generate_trips_for_schedule
from .factories import ScheduleFactory, TripFactory

pytestmark = pytest.mark.django_db

# BusinessFactory's default timezone (see apps/businesses/tests/factories.py)
# — generate_trips_for_schedule/_cancel_future_trips_for_schedule resolve
# "today" via this timezone, not server-local, so tests do the same rather
# than freezing time.
_TZ = ZoneInfo("Africa/Lagos")


def _today() -> datetime.date:
    return datetime.datetime.now(_TZ).date()


def _schedule(client: object, **overrides: object) -> Schedule:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return ScheduleFactory(client=client, **overrides)


def test_generate_trips_for_schedule_respects_days_of_week_within_the_horizon() -> None:
    client = ClientFactory()
    today = _today()
    # A one-week horizon with only today's weekday active: exactly one
    # offset (0, i.e. today itself) can match.
    schedule = _schedule(
        client,
        days_of_week=[today.isoweekday()],
        effective_from=today - datetime.timedelta(days=30),
        effective_until=None,
    )

    with tenant_context(str(client.id)):
        created = generate_trips_for_schedule(schedule, horizon_days=6)

    assert {trip.service_date for trip in created} == {today}


def test_generate_trips_for_schedule_respects_effective_from_and_until() -> None:
    client = ClientFactory()
    today = _today()
    schedule = _schedule(
        client,
        days_of_week=[1, 2, 3, 4, 5, 6, 7],
        effective_from=today + datetime.timedelta(days=2),
        effective_until=today + datetime.timedelta(days=3),
    )

    with tenant_context(str(client.id)):
        created = generate_trips_for_schedule(schedule, horizon_days=6)

    assert {trip.service_date for trip in created} == {
        today + datetime.timedelta(days=2),
        today + datetime.timedelta(days=3),
    }


def test_generate_trips_for_schedule_is_idempotent() -> None:
    client = ClientFactory()
    today = _today()
    schedule = _schedule(
        client,
        days_of_week=[today.isoweekday()],
        effective_from=today - datetime.timedelta(days=30),
        effective_until=None,
    )

    with tenant_context(str(client.id)):
        first_run = generate_trips_for_schedule(schedule, horizon_days=6)
        second_run = generate_trips_for_schedule(schedule, horizon_days=6)
        trip_count = Trip.all_objects.filter(schedule=schedule).count()

    assert len(first_run) == 1
    assert second_run == []
    assert trip_count == 1


def test_generate_trips_for_schedule_raises_for_an_invalid_timezone() -> None:
    client = ClientFactory()
    today = _today()
    schedule = _schedule(
        client,
        days_of_week=[today.isoweekday()],
        effective_from=today - datetime.timedelta(days=30),
        effective_until=None,
    )
    with tenant_context(str(client.id)):
        schedule.business.timezone = "Not/A_Real_Zone"
        schedule.business.save(update_fields=["timezone"])

        with pytest.raises(ZoneInfoNotFoundError):
            generate_trips_for_schedule(schedule, horizon_days=6)


def test_generate_trips_skips_a_schedule_with_an_invalid_timezone_without_crashing() -> None:
    client = ClientFactory()
    today = _today()
    good_schedule = _schedule(
        client,
        days_of_week=[today.isoweekday()],
        effective_from=today - datetime.timedelta(days=30),
        effective_until=None,
    )
    bad_schedule = _schedule(
        client,
        days_of_week=[today.isoweekday()],
        effective_from=today - datetime.timedelta(days=30),
        effective_until=None,
    )
    with tenant_context(str(client.id)):
        bad_schedule.business.timezone = "Not/A_Real_Zone"
        bad_schedule.business.save(update_fields=["timezone"])

    generate_trips.run()

    entry = AuditLog.objects.get(action="scheduling.trips_generated")
    assert entry.metadata["schedule_count"] == 2
    assert entry.metadata["skipped_invalid_timezone"] == [str(bad_schedule.id)]
    assert entry.metadata["trip_count"] >= 1
    assert good_schedule.id  # sanity: fixture used


def test_generate_trips_only_touches_active_schedules() -> None:
    client = ClientFactory()
    today = _today()
    _schedule(
        client,
        days_of_week=[today.isoweekday()],
        effective_from=today - datetime.timedelta(days=30),
        effective_until=None,
        is_active=False,
    )

    generate_trips.run()

    with platform_staff_bypass():
        assert Trip.all_objects.count() == 0


def test_update_schedule_narrowing_days_cancels_only_the_now_mismatched_future_trips() -> None:
    client = ClientFactory()
    today = _today()
    tomorrow = today + datetime.timedelta(days=1)
    day_a, day_b = today.isoweekday(), tomorrow.isoweekday()
    schedule = _schedule(
        client,
        days_of_week=sorted({day_a, day_b}),
        effective_from=today - datetime.timedelta(days=30),
        effective_until=None,
    )
    with tenant_context(str(client.id)):
        staff = ClientStaffUserFactory(client=client)
        still_matching_trip = TripFactory(
            client=client,
            schedule=schedule,
            route=schedule.route,
            business=schedule.business,
            service_date=today,
            status=Trip.Status.SCHEDULED,
        )
        now_mismatched_trip = TripFactory(
            client=client,
            schedule=schedule,
            route=schedule.route,
            business=schedule.business,
            service_date=tomorrow,
            status=Trip.Status.SCHEDULED,
        )

        update_schedule(schedule=schedule, updated_by=staff, days_of_week=[day_a])

        still_matching_trip.refresh_from_db()
        now_mismatched_trip.refresh_from_db()

    assert still_matching_trip.status == Trip.Status.SCHEDULED
    assert now_mismatched_trip.status == Trip.Status.CANCELLED
    assert now_mismatched_trip.cancellation_reason == "Schedule updated"


def test_update_schedule_deactivating_cancels_all_future_scheduled_trips() -> None:
    client = ClientFactory()
    today = _today()
    schedule = _schedule(
        client,
        days_of_week=[today.isoweekday()],
        effective_from=today - datetime.timedelta(days=30),
        effective_until=None,
    )
    with tenant_context(str(client.id)):
        staff = ClientStaffUserFactory(client=client)
        trip = TripFactory(
            client=client,
            schedule=schedule,
            route=schedule.route,
            business=schedule.business,
            service_date=today,
            status=Trip.Status.SCHEDULED,
        )
        in_progress_trip = TripFactory(
            client=client,
            schedule=schedule,
            route=schedule.route,
            business=schedule.business,
            service_date=today + datetime.timedelta(days=5),
            status=Trip.Status.IN_PROGRESS,
        )

        update_schedule(schedule=schedule, updated_by=staff, is_active=False)

        trip.refresh_from_db()
        in_progress_trip.refresh_from_db()

    assert trip.status == Trip.Status.CANCELLED
    assert in_progress_trip.status == Trip.Status.IN_PROGRESS
