"""Slice 1 of docs/specs/10-booking-modes.md — the axes that replaced
`tap_and_go`, and the backfill that migrated it.

The backfill functions are called **directly** rather than through a
migration-replay harness (no such library is in this project, and
adding one for two functions is not worth the dependency).

That works only because those functions read through `all_objects`.
A migration receives historical models whose managers are all plain and
unscoped; the real registry passed here gives `TenantScopedManager` for
`objects`, which matches nothing outside a `tenant_context`. Writing
the backfill against `objects` made every test here fail as a silent
no-op — which is precisely the failure the migration exists to guard
against, so the test earned its place before it ever passed.

What this does *not* cover: the ordering of the four migrations
against each other. That is asserted by `manage.py migrate --plan` and
by the migration files' own explicit dependencies.
"""

import datetime
import importlib

import pytest
from django.apps import apps as django_apps

from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import ClientStaffUserFactory
from apps.network.tests.factories import RouteFactory
from apps.scheduling.services import create_manual_trip
from apps.scheduling.tests.factories import TripFactory

# A module name starting with a digit is not a valid Python
# identifier, so this cannot be a plain `from ... import`.
backfill_migration = importlib.import_module(
    "apps.businesses.migrations.0010_backfill_booking_mode_axes"
)

pytestmark = pytest.mark.django_db


def _run_forwards() -> None:
    backfill_migration.split_tap_and_go(django_apps, None)


def _run_backwards() -> None:
    backfill_migration.rejoin_tap_and_go(django_apps, None)


class TestBackfill:
    def test_splits_tap_and_go_into_open_seating_plus_pay_as_you_go(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            business = BusinessFactory(client=client, booking_mode_default="tap_and_go")
            trip = TripFactory(client=client, booking_mode="tap_and_go")

        _run_forwards()

        business.refresh_from_db()
        trip.refresh_from_db()
        assert business.booking_mode_default == Business.BookingMode.OPEN_SEATING
        assert business.fare_collection_mode == Business.FareCollectionMode.PAY_AS_YOU_GO
        assert trip.booking_mode == Business.BookingMode.OPEN_SEATING
        assert trip.fare_collection_mode == Business.FareCollectionMode.PAY_AS_YOU_GO

    def test_leaves_reservation_rows_prepaid(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            business = BusinessFactory(client=client, booking_mode_default="reservation")
            trip = TripFactory(client=client, booking_mode="reservation")

        _run_forwards()

        business.refresh_from_db()
        trip.refresh_from_db()
        assert business.booking_mode_default == Business.BookingMode.RESERVATION
        assert business.fare_collection_mode == Business.FareCollectionMode.PREPAID
        assert trip.booking_mode == Business.BookingMode.RESERVATION
        assert trip.fare_collection_mode == Business.FareCollectionMode.PREPAID

    def test_reverse_restores_tap_and_go(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            business = BusinessFactory(client=client, booking_mode_default="tap_and_go")
            trip = TripFactory(client=client, booking_mode="tap_and_go")

        _run_forwards()
        _run_backwards()

        business.refresh_from_db()
        trip.refresh_from_db()
        assert business.booking_mode_default == "tap_and_go"
        assert trip.booking_mode == "tap_and_go"

    def test_reverse_leaves_prepaid_open_seating_alone(self) -> None:
        """Open seating that was always prepaid is new — it has no
        pre-split equivalent, so the reverse must not invent one by
        folding it into a value it never held."""
        client = ClientFactory()
        with tenant_context(str(client.id)):
            business = BusinessFactory(
                client=client,
                booking_mode_default=Business.BookingMode.OPEN_SEATING,
                fare_collection_mode=Business.FareCollectionMode.PREPAID,
            )

        _run_backwards()

        business.refresh_from_db()
        assert business.booking_mode_default == Business.BookingMode.OPEN_SEATING

    def test_is_idempotent(self) -> None:
        """Running twice must not move a row a second time — the
        row-count assertions inside would fail loudly if it did."""
        client = ClientFactory()
        with tenant_context(str(client.id)):
            business = BusinessFactory(client=client, booking_mode_default="tap_and_go")

        _run_forwards()
        _run_forwards()

        business.refresh_from_db()
        assert business.fare_collection_mode == Business.FareCollectionMode.PAY_AS_YOU_GO


class TestTripSnapshot:
    def test_manual_trip_snapshots_both_mode_fields(self) -> None:
        """A Business changing how it collects fares must not change the
        terms of a departure passengers have already booked."""
        client = ClientFactory()
        actor = ClientStaffUserFactory(client=client)
        with tenant_context(str(client.id)):
            business = BusinessFactory(
                client=client,
                booking_mode_default=Business.BookingMode.OPEN_SEATING,
                fare_collection_mode=Business.FareCollectionMode.PAY_AS_YOU_GO,
            )
            route = RouteFactory(client=client, business=business)
            trip = create_manual_trip(
                route=route,
                service_date=datetime.date(2026, 8, 10),
                departure_time=datetime.time(6, 30),
                vehicle=None,
                driver=None,
                created_by=actor,
            )

            assert trip.fare_collection_mode == Business.FareCollectionMode.PAY_AS_YOU_GO

            # Changing the Business afterwards leaves the snapshot alone.
            business.fare_collection_mode = Business.FareCollectionMode.PREPAID
            business.save(update_fields=["fare_collection_mode"])
            trip.refresh_from_db()

        assert trip.fare_collection_mode == Business.FareCollectionMode.PAY_AS_YOU_GO

    def test_defaults_to_prepaid(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip = TripFactory(client=client)
        assert trip.fare_collection_mode == Business.FareCollectionMode.PREPAID
