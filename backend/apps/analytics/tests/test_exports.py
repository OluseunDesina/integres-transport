"""CSV export — docs/specs/16-operational-analytics.md's "Export" section.

Two kinds of test dominate this file, and both are about *agreement*
rather than about values:

- **Parity.** Every export is a file of the rows some endpoint already
  serves. A file that disagrees with the screen it was downloaded from
  is the exact failure the shared filter module exists to prevent, and it
  is the kind nobody notices until a reconciliation goes wrong weeks
  later. So each resource is asserted against its own endpoint rather
  than against hand-written expected values.
- **Isolation.** Parametrised over the whole registry, in pairs: the
  neighbour's row is absent *and* the caller's own row is present, so
  isolation can never be achieved by returning nothing to anybody.

`test_export_materialisation.py` holds the tenancy-safety tests, which
are a different concern.
"""

from datetime import timedelta
from decimal import Decimal

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework import status

from apps.analytics.exports import EXPORTS
from apps.booking.services import create_booking, mark_booking_paid
from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.fares.tests.factories import FareRuleFactory
from apps.fleet.tests.factories import VehicleFactory, VehicleTypeFactory
from apps.identity.models import Role
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory
from apps.network.models import Route
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.payments.models import PaymentIntent
from apps.scheduling.models import Trip
from apps.scheduling.services import transition_trip_status
from apps.scheduling.tests.factories import TripFactory
from apps.tapngo.models import FareJourney
from apps.tapngo.tests.factories import TapCredentialFactory
from apps.ticketing.capacity import get_capacity

from .helpers import (
    auth_client,
    business_for,
    csv_rows,
    csv_text,
    export_url,
    fund_wallet,
    pay_a_booking,
    pay_a_booking_partly_from_wallet,
    required_export_params,
)

pytestmark = pytest.mark.django_db

#: Which codename each resource is gated on, restated here rather than
#: read off the registry: a test that imported the answer from the thing
#: it is testing would pass no matter what the answer became.
EXPECTED_PERMISSION = {
    "transactions": "payments.view",
    "bookings": "booking.view",
    "revenue": "analytics.view",
    "revenue-trend": "analytics.view",
    "route-revenue": "analytics.view",
    "trip-class-revenue": "analytics.view",
    "trip-performance": "analytics.view",
    # Spec 18 slice 1. `booking.view`, not `analytics.view`: the person
    # who most needs the manifest is the one standing at the door, and
    # the Staff preset holds `booking.view` but deliberately not
    # `analytics.view`.
    "manifest": "booking.view",
}


def _export(staff, resource, **params):  # type: ignore[no-untyped-def]
    return auth_client(staff).get(export_url(resource), params)


# --- parity -----------------------------------------------------------


def test_the_summary_the_list_and_the_export_describe_the_same_rows() -> None:
    """The three-way parity the spec asks for.

    Slice 2 could only assert two of the three surfaces because the
    export did not exist yet, and said so. This completes it.

    A **blended** payment is in the fixture on purpose:
    `PaymentIntent.amount` is the Paystack leg only, so any of the three
    that summed it without `wallet_component_amount` would be wrong about
    that row and right about every other — which is exactly the mistake
    slice 2's own hand-written reconciliation made.
    """
    client = ClientFactory()
    business = business_for(client)
    first, _intent = pay_a_booking(
        client, business, amount="1000.00", channel="card", idempotency_key="k1"
    )
    fund_wallet(client, business, first.passenger, "300.00")
    pay_a_booking_partly_from_wallet(
        client, business, first.passenger, amount="500.00", idempotency_key="k2"
    )
    staff = ClientStaffUserFactory(client=client)

    filters = {"business": str(business.id), "status": "succeeded"}
    summary = auth_client(staff).get(reverse("analytics-payment-summary"), filters)
    listing = auth_client(staff).get(reverse("payment-list-create"), {"limit": 100, **filters})
    rows = csv_rows(_export(staff, "transactions", **filters))

    assert summary.data["counts"]["total"] == listing.data["count"] == len(rows)

    collected = sum(Decimal(row["collected"]) for row in summary.data["money"])
    listed = sum(
        Decimal(row["amount"]) + Decimal(row["wallet_component_amount"])
        for row in listing.data["results"]
    )
    exported = sum(Decimal(row["total_paid"]) for row in rows)
    assert collected == listed == exported
    # The blended row is genuinely split, so a surface ignoring the
    # wallet leg would differ here rather than coincidentally agree.
    assert any(Decimal(row["wallet_component_amount"]) > 0 for row in rows)


def test_revenue_export_matches_the_revenue_endpoint_cell_for_cell() -> None:
    client = ClientFactory()
    business = business_for(client)
    pay_a_booking(client, business, amount="1000.00", channel="card", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    filters = {"business": str(business.id)}
    report = auth_client(staff).get(reverse("analytics-revenue"), filters).data
    rows = csv_rows(_export(staff, "revenue", **filters))

    assert len(rows) == len(report["money"]) == 1
    for key in ("currency", "revenue", "gross", "commission", "average_ticket_value"):
        assert rows[0][key] == str(report["money"][0][key]), key
    assert int(rows[0]["transaction_volume"]) == report["money"][0]["transaction_volume"]
    # Aggregate rows carry the period, since they have no timestamp of
    # their own — a saved file must still say what it covers.
    assert rows[0]["date_from"] == str(report["period"]["from"])
    assert rows[0]["timezone"] == report["period"]["timezone"]


@pytest.mark.parametrize(
    ("resource", "key", "label"),
    [
        ("route-revenue", "by_route", "route"),
        ("trip-class-revenue", "by_trip_class", "trip_class"),
    ],
)
def test_dimension_revenue_exports_rename_amount_and_change_nothing_else(
    resource: str, key: str, label: str
) -> None:
    """`gross_amount`, not `amount`.

    `breakdown_by` returns gross while the `revenue` file's own `revenue`
    column is net, and two files with a column called `amount` meaning
    different things is the plausible wrongness this spec exists to
    prevent. This proves the rename is a rename — every other cell is
    identical to the endpoint's.
    """
    client = ClientFactory()
    business = business_for(client)
    pay_a_booking(client, business, amount="1000.00", channel="card", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    filters = {"business": str(business.id)}
    report = auth_client(staff).get(reverse("analytics-revenue"), filters).data
    rows = csv_rows(_export(staff, resource, **filters))

    assert len(rows) == len(report[key]) == 1
    assert rows[0][label] == report[key][0][label]
    assert rows[0]["currency"] == report[key][0]["currency"]
    assert rows[0]["gross_amount"] == str(report[key][0]["amount"])
    assert "amount" not in rows[0]


def test_revenue_trend_export_matches_the_endpoints_trend() -> None:
    client = ClientFactory()
    business = business_for(client)
    pay_a_booking(client, business, amount="1000.00", channel="card", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    filters = {"business": str(business.id)}
    report = auth_client(staff).get(reverse("analytics-revenue"), filters).data
    rows = csv_rows(_export(staff, "revenue-trend", **filters))

    assert [(row["date"], row["currency"], row["amount"]) for row in rows] == [
        (str(point["date"]), point["currency"], str(point["amount"]))
        for point in report["trend"]
    ]
    assert rows[0]["granularity"] == "day"


def test_bookings_export_matches_the_bookings_list() -> None:
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(
        client, business, amount="1000.00", channel="card", idempotency_key="k1"
    )
    staff = ClientStaffUserFactory(client=client)

    filters = {"business": str(business.id)}
    listing = auth_client(staff).get(reverse("booking-list-create"), {"limit": 100, **filters})
    rows = csv_rows(_export(staff, "bookings", **filters))

    assert listing.data["count"] == len(rows)
    assert rows[0]["booking_id"] == str(booking.id)
    assert Decimal(rows[0]["total_amount"]) == booking.total_amount


# --- the bookings-list migration -------------------------------------


def test_a_booking_status_filter_narrows_the_list_and_the_export_identically() -> None:
    """`?status=paid` on `GET /bookings/`.

    Before slice 4 this list hand-wrote its own filter chain, so an
    export of it honoured only `business` — a status-filtered screen
    would have exported every status, silently. And once it adopted the
    shared module, `?status=paid` would have 400'd against
    *PaymentIntent*'s choices, which is why `booking_status` is a
    separate dimension.
    """
    client = ClientFactory()
    business = business_for(client)
    pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    filters = {"business": str(business.id), "status": "paid"}
    listing = auth_client(staff).get(reverse("booking-list-create"), {"limit": 100, **filters})
    rows = csv_rows(_export(staff, "bookings", business=str(business.id), booking_status="paid"))

    assert listing.status_code == status.HTTP_200_OK
    assert listing.data["count"] == len(rows) == 1
    assert rows[0]["status"] == "paid"

    cancelled = auth_client(staff).get(
        reverse("booking-list-create"),
        {"limit": 100, "business": str(business.id), "status": "cancelled"},
    )
    assert cancelled.data["count"] == 0


def test_a_record_list_and_its_export_are_not_truncated_to_a_default_period() -> None:
    """A real, shipped bug, caught while building this slice.

    Slice 2 pointed `GET /payments/` at the aggregate filter function, so
    from then until now that list — a support and dispute screen — showed
    only the last 30 days, with no chip, no message and no error. A
    payment from two months ago simply was not there. It went unnoticed
    because every fixture and every row in the dev database was recent.

    Aggregates keep their rolling default, because a dashboard with no
    period is meaningless. A paginated list is bounded by its pagination
    instead, and its export by `EXPORT_MAX_ROWS`.
    """
    client = ClientFactory()
    business = business_for(client)
    booking, intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    with platform_staff_bypass():
        old = timezone.now() - timedelta(days=60)
        PaymentIntent.all_objects.filter(pk=intent.pk).update(created_at=old)
        type(booking).all_objects.filter(pk=booking.pk).update(created_at=old)
    staff = ClientStaffUserFactory(client=client)

    filters = {"business": str(business.id)}
    payments = auth_client(staff).get(reverse("payment-list-create"), {"limit": 100, **filters})
    bookings = auth_client(staff).get(reverse("booking-list-create"), {"limit": 100, **filters})

    assert payments.data["count"] == 1
    assert bookings.data["count"] == 1
    assert len(csv_rows(_export(staff, "transactions", **filters))) == 1
    assert len(csv_rows(_export(staff, "bookings", **filters))) == 1

    # …and an explicitly named period still narrows, on both.
    recent = {**filters, "date_from": str(timezone.now().date())}
    assert len(csv_rows(_export(staff, "transactions", **recent))) == 0
    assert (
        auth_client(staff).get(reverse("payment-list-create"), {"limit": 100, **recent}).data[
            "count"
        ]
        == 0
    )


def test_an_unbounded_export_is_named_all_rather_than_claiming_a_period() -> None:
    """The filename must not claim a window the file does not respect."""
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)

    unbounded = _export(staff, "transactions", business=str(business.id))
    bounded = _export(staff, "revenue", business=str(business.id))

    assert 'filename="integra-transactions-all.csv"' in unbounded["Content-Disposition"]
    assert "-to-" in bounded["Content-Disposition"]


# --- trip performance -------------------------------------------------


def _performance(staff, trip_id):  # type: ignore[no-untyped-def]
    return auth_client(staff).get(
        reverse("analytics-trip-performance", kwargs={"pk": str(trip_id)})
    )


def _row_for(rows, trip_id):  # type: ignore[no-untyped-def]
    matches = [row for row in rows if row["trip_id"] == str(trip_id)]
    assert len(matches) == 1, f"expected one row for {trip_id}, got {len(matches)}"
    return matches[0]


def _performance_filters(trip: Trip) -> dict[str, str]:
    return {
        "business": str(trip.business_id),
        "date_from": str(trip.service_date),
        "date_to": str(trip.service_date),
    }


def test_trip_performance_export_agrees_with_the_endpoint_for_a_paid_trip() -> None:
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)
    trip = booking.trip

    detail = _performance(staff, trip.id).data
    rows = csv_rows(_export(staff, "trip-performance", **_performance_filters(trip)))
    row = _row_for(rows, trip.id)

    assert int(row["seats_sold"]) == detail["capacity"]["seats_sold"]
    assert int(row["total_seats"]) == detail["capacity"]["total_seats"]
    assert row["occupancy_rate"] == str(detail["capacity"]["occupancy_rate"])
    assert row["currency"] == detail["money"][0]["currency"]
    assert row["revenue"] == str(detail["money"][0]["revenue"])
    assert row["gross"] == str(detail["money"][0]["gross"])
    assert row["revenue_per_seat"] == str(detail["money"][0]["revenue_per_seat"])


def test_occupancy_is_an_empty_cell_without_a_vehicle_never_a_zero() -> None:
    """A blank and a `0.000` must not look the same in a spreadsheet —
    the CSV expression of the endpoint's own null discipline."""
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    with tenant_context(str(client.id)):
        Trip.objects.filter(pk=booking.trip_id).update(vehicle=None)
    staff = ClientStaffUserFactory(client=client)
    with platform_staff_bypass():
        trip = Trip.all_objects.get(pk=booking.trip_id)

    detail = _performance(staff, trip.id).data
    rows = csv_rows(_export(staff, "trip-performance", **_performance_filters(trip)))
    row = _row_for(rows, trip.id)

    assert detail["capacity"]["occupancy_rate"] is None
    assert row["occupancy_rate"] == ""
    assert row["total_seats"] == ""
    # Sold is still known — it is the *denominator* that is unknowable.
    # Reporting the rate as 0% would read as "nobody bought a seat" on a
    # departure that in fact sold one and has no bus assigned yet.
    assert row["seats_sold"] == "1"


def test_punctuality_columns_are_blank_together_before_departure() -> None:
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)
    trip = booking.trip

    detail = _performance(staff, trip.id).data
    rows = csv_rows(_export(staff, "trip-performance", **_performance_filters(trip)))
    row = _row_for(rows, trip.id)

    assert detail["punctuality"] is None
    assert row["actual_departure_at"] == ""
    assert row["actual_arrival_at"] == ""
    assert row["delay_minutes"] == ""
    assert row["on_time"] == ""
    # …but the scheduled time is still there. It is a fact about the
    # trip, not about its punctuality, and a file where no future
    # departure has one is materially less useful.
    assert row["scheduled_departure_at"] != ""


def test_a_cancelled_trip_is_exported_but_drags_no_average() -> None:
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)
    trip = booking.trip
    with tenant_context(str(client.id)):
        transition_trip_status(
            trip=trip, new_status=Trip.Status.CANCELLED, reason="Vehicle fault", actor=staff
        )

    detail = _performance(staff, trip.id).data
    rows = csv_rows(_export(staff, "trip-performance", **_performance_filters(trip)))
    row = _row_for(rows, trip.id)

    assert detail["capacity"]["occupancy_rate"] is None
    assert row["cancelled"] == "true"
    assert row["occupancy_rate"] == ""
    # Counted, not vanished: the money it took is still in the file.
    assert Decimal(row["gross"]) > 0


def test_a_trip_with_no_payments_still_gets_a_row_in_its_own_currency() -> None:
    client = ClientFactory()
    business = business_for(client)
    booking, intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    with tenant_context(str(client.id)):
        PaymentIntent.objects.filter(pk=intent.pk).update(
            status=PaymentIntent.Status.CANCELLED
        )
    staff = ClientStaffUserFactory(client=client)
    trip = booking.trip

    rows = csv_rows(_export(staff, "trip-performance", **_performance_filters(trip)))
    row = _row_for(rows, trip.id)

    assert row["currency"] == business.currency
    assert row["revenue"] == "0.00"
    assert row["gross"] == "0.00"


def _open_seating_trip(  # type: ignore[no-untyped-def]
    client, *, capacity=10, capacity_enforced=True, with_vehicle=True
):
    """A three-stop open-seating trip, mirroring
    `apps/booking/tests/test_open_seating.py`'s own fixture — kept local
    rather than imported, since that one is a private test helper."""
    business = BusinessFactory(
        client=client,
        booking_mode_default=Business.BookingMode.OPEN_SEATING,
        capacity_enforced=capacity_enforced,
    )
    route = RouteFactory(client=client, business=business)
    stops = []
    for sequence in range(1, 4):
        stop = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop, sequence=sequence)
        stops.append(stop)

    vehicle = None
    if with_vehicle:
        vehicle_type = VehicleTypeFactory(client=client, business=business, capacity=capacity)
        vehicle = VehicleFactory(client=client, business=business, vehicle_type=vehicle_type)

    departure = timezone.now() + timedelta(hours=2)
    trip = TripFactory(
        client=client,
        route=route,
        business=business,
        vehicle=vehicle,
        booking_mode=Business.BookingMode.OPEN_SEATING,
        service_date=departure.date(),
        scheduled_departure_at=departure,
    )
    FareRuleFactory(client=client, route=route, business=business, amount="500.00")
    return trip, stops


@pytest.mark.parametrize("capacity_enforced", [True, False])
def test_open_seating_sold_matches_get_capacity(capacity_enforced: bool) -> None:
    """Pins the claim `trip_performance_rows` makes in a comment.

    The set-wise count drops `get_capacity`'s segment-overlap predicate,
    on the reasoning that its whole-trip window `[0, 10_000)` overlaps
    every real `segment_range` and so is a no-op at trip grain. That is
    exactly the kind of reasoning that stays true until someone changes
    the window, so it is asserted against the real function rather than
    left as prose.

    Both capacity modes, because the **denominator** branches on
    `capacity_enforced`: unenforced means the total is unknowable, and
    unknowable must render as an empty cell rather than as a zero.
    """
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        trip, stops = _open_seating_trip(client, capacity_enforced=capacity_enforced)
        booking = create_booking(
            trip=trip,
            passenger=PassengerUserFactory(client=client),
            passenger_count=3,
            from_stop=stops[0],
            to_stop=stops[2],
            idempotency_key="k1",
        )
    mark_booking_paid(booking=booking)

    with platform_staff_bypass():
        trip = Trip.all_objects.select_related("business", "vehicle__vehicle_type").get(
            pk=trip.pk
        )
    rows = csv_rows(_export(staff, "trip-performance", **_performance_filters(trip)))
    row = _row_for(rows, trip.id)

    with tenant_context(str(client.id)):
        capacity = get_capacity(trip=trip, from_sequence=0, to_sequence=10_000)

    assert capacity.sold == 3
    assert int(row["seats_sold"]) == capacity.sold
    assert (row["total_seats"] or None) == (
        str(capacity.total) if capacity.total is not None else None
    )
    if capacity_enforced:
        assert row["total_seats"] == "10"
    else:
        # Unknowable, not unlimited and not zero.
        assert row["total_seats"] == ""
        assert row["occupancy_rate"] == ""


def test_trip_performance_export_is_a_bounded_number_of_queries(
    django_assert_max_num_queries,  # type: ignore[no-untyped-def]
) -> None:
    """`trip_performance()` is five to seven queries **per trip**; at the
    row cap that would be several hundred thousand. This is the test that
    goes red if an N+1 is reintroduced."""
    client = ClientFactory()
    business = business_for(client)
    trips = []
    for index in range(6):
        booking, _intent = pay_a_booking(
            client, business, amount="1000.00", idempotency_key=f"k{index}"
        )
        trips.append(booking.trip)
    staff = ClientStaffUserFactory(client=client)

    with tenant_context(str(client.id)):
        from apps.analytics.filters import resolve_filters
        from apps.analytics.services import trip_performance_rows

        # Dated explicitly, for the same reason the isolation test is —
        # a trip seeded a few hours out lands on tomorrow late in the day.
        filters = resolve_filters(
            {
                "business": str(business.id),
                "date_from": str(timezone.now().date() - timedelta(days=1)),
                "date_to": str(timezone.now().date() + timedelta(days=2)),
            }
        )
        with django_assert_max_num_queries(10):
            rows = trip_performance_rows(filters)

    assert len(rows) >= len(trips)
    assert staff is not None


# --- the row cap ------------------------------------------------------


def test_over_the_cap_is_a_refusal_naming_both_numbers(settings) -> None:  # type: ignore[no-untyped-def]
    """And **no `Content-Disposition`** — a truncated file that looks
    complete is the failure the cap exists to prevent, so the refusal
    must not resemble a download at all."""
    settings.EXPORT_MAX_ROWS = 2
    client = ClientFactory()
    business = business_for(client)
    for index in range(3):
        pay_a_booking(client, business, amount="100.00", idempotency_key=f"k{index}")
    staff = ClientStaffUserFactory(client=client)

    response = _export(staff, "transactions", business=str(business.id))

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "3" in response.data["detail"]
    assert "2" in response.data["detail"]
    assert "Content-Disposition" not in response


def test_exactly_at_the_cap_succeeds(settings) -> None:  # type: ignore[no-untyped-def]
    settings.EXPORT_MAX_ROWS = 2
    client = ClientFactory()
    business = business_for(client)
    for index in range(2):
        pay_a_booking(client, business, amount="100.00", idempotency_key=f"k{index}")
    staff = ClientStaffUserFactory(client=client)

    assert len(csv_rows(_export(staff, "transactions", business=str(business.id)))) == 2


# --- shape, permissions, isolation ------------------------------------


@pytest.mark.parametrize("resource", sorted(EXPORTS))
def test_an_empty_result_is_still_a_file_with_its_header_row(resource: str) -> None:
    """A caller who filtered to nothing gets a valid, openable file that
    says what the columns would have been — not a blank body."""
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    # Built **only** for a resource that declares it needs one. This
    # test's whole subject is a caller who filtered down to nothing, and
    # a trip seeded unconditionally is itself a row in the
    # `trip-performance` export — so the fixture the `manifest` resource
    # needs must not exist for the resources that do not.
    trip_id = None
    if EXPORTS[resource].required_filters:
        with tenant_context(str(client.id)):
            route = RouteFactory(client=client, business=business)
            trip_id = str(TripFactory(client=client, route=route, business=business).id)

    response = _export(
        staff,
        resource,
        business=str(business.id),
        **required_export_params(resource, trip_id=trip_id),
    )
    body = csv_text(response)

    assert csv_rows(response) == []
    assert body.splitlines()[0] == ",".join(EXPORTS[resource].columns)
    assert response.content.startswith(b"\xef\xbb\xbf")


@pytest.mark.parametrize("resource", sorted(EXPORTS))
def test_another_clients_rows_are_in_no_export_and_the_callers_own_are(resource: str) -> None:
    """The mandatory isolation set, in pairs.

    The second half matters as much as the first: isolation achieved by
    returning nothing to anybody would pass a one-sided test and be
    useless.
    """
    neighbour = ClientFactory()
    neighbour_business = business_for(neighbour)
    neighbour_booking, _ = pay_a_booking(
        neighbour, neighbour_business, amount="9999.00", idempotency_key="n1"
    )

    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1111.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    # An explicit, wide period rather than the rolling default. The
    # `trip-performance` resource narrows on `service_date`, and a trip
    # seeded a few hours from now lands on *tomorrow* when this runs late
    # in the day — which made this test's own fixture invisible to it and
    # the "own rows are present" half pass vacuously. 81 days stays under
    # the 92-day cap a daily trend carries.
    window = {
        "date_from": str(timezone.now().date() - timedelta(days=40)),
        "date_to": str(timezone.now().date() + timedelta(days=40)),
    }
    body = csv_text(
        _export(
            staff,
            resource,
            **window,
            **required_export_params(resource, trip_id=str(booking.trip_id)),
        )
    )

    assert "9999.00" not in body
    assert str(neighbour_booking.id) not in body
    assert str(neighbour_business.name) not in body
    if resource in {"transactions", "bookings"}:
        assert str(booking.passenger.email) in body
    else:
        assert business.currency in body


@pytest.mark.parametrize("resource", sorted(EXPORTS))
def test_each_resource_is_gated_on_the_surface_it_exports(resource: str) -> None:
    """A caller who can read a list can read it as a file — so there is
    no new `export.perform` codename. The Staff preset carries
    `payments.view` and `booking.view` but deliberately not
    `analytics.view`, which is what makes this a real distinction."""
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    booking, _intent = pay_a_booking(client, business, amount="1.00", idempotency_key="gate")
    with tenant_context(str(client.id)):
        staff.role = Role.objects.get(client=client, name="Staff")
        staff.save(update_fields=["role"])

    response = _export(
        staff, resource, **required_export_params(resource, trip_id=str(booking.trip_id))
    )

    if EXPECTED_PERMISSION[resource] == "analytics.view":
        assert response.status_code == status.HTTP_403_FORBIDDEN
    else:
        assert response.status_code == status.HTTP_200_OK


def test_an_unknown_resource_is_a_404_not_a_403() -> None:
    """A misleading 403 would send an operator to ask for a permission
    that would not have helped.

    The example used to be `incidents`, chosen when no such domain
    existed. `apps.incidents` is real as of docs/specs/17-incidents.md
    and deliberately ships **no** export resource, so that name now
    reads as a stale test rather than a deliberate one — hence a name
    that cannot become a resource by accident. Adding any export
    resource stays a deliberate act; this test is not what guards it.
    """
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    response = auth_client(staff).get("/api/v1/exports/not-a-resource/")

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_an_anonymous_caller_gets_nothing() -> None:
    from rest_framework.test import APIClient

    response = APIClient().get(export_url("transactions"))

    assert response.status_code == status.HTTP_401_UNAUTHORIZED


# --- formatting -------------------------------------------------------


def test_rows_are_rfc_4180_and_carry_a_bom_for_excel() -> None:
    client = ClientFactory()
    business = business_for(client)
    pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    response = _export(staff, "transactions", business=str(business.id))

    assert response.content.startswith(b"\xef\xbb\xbf")
    assert b"\r\n" in response.content


def test_a_route_named_like_a_formula_is_escaped() -> None:
    """Route and stop names are operator-entered text that lands on
    another operator's machine, where Excel and Sheets execute a leading
    `=` as a formula."""
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    with tenant_context(str(client.id)):
        Route.objects.filter(pk=booking.trip.route_id).update(name="=1+1")
    staff = ClientStaffUserFactory(client=client)

    rows = csv_rows(_export(staff, "transactions", business=str(business.id)))

    assert rows[0]["route"] == "'=1+1"


def test_a_negative_money_value_is_not_mangled_by_the_formula_guard() -> None:
    """`-1500.00` legitimately starts with `-`, so the guard applies only
    to values that do not parse as a number."""
    from apps.analytics.exports import _cell

    assert _cell("-1500.00") == "-1500.00"
    assert _cell("+42") == "+42"
    assert _cell("=cmd") == "'=cmd"
    assert _cell("-- not a number") == "'-- not a number"


def test_timestamps_render_in_the_periods_own_timezone_with_an_offset() -> None:
    """A bare UTC timestamp beside a Lagos-day bucket is the
    23:30-crosses-midnight confusion this spec's own test plan names."""
    client = ClientFactory()
    business = business_for(client)
    pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    rows = csv_rows(_export(staff, "transactions", business=str(business.id)))

    assert business.timezone == "Africa/Lagos"
    assert rows[0]["created_at"].endswith("+01:00")


def test_a_blank_channel_reports_unknown_and_a_wallet_payment_reports_wallet() -> None:
    client = ClientFactory()
    business = business_for(client)
    first, _intent = pay_a_booking(
        client, business, amount="1000.00", channel=None, idempotency_key="k1"
    )
    fund_wallet(client, business, first.passenger, "300.00")
    pay_a_booking_partly_from_wallet(
        client, business, first.passenger, amount="200.00", idempotency_key="k2"
    )
    staff = ClientStaffUserFactory(client=client)

    rows = csv_rows(_export(staff, "transactions", business=str(business.id)))
    channels = {row["channel"] for row in rows}

    assert "unknown" in channels
    assert "" not in channels


def test_passenger_identity_is_carried_in_full() -> None:
    """Deliberate, and the reason every export is audit-logged: with a
    name and an email in it, a saved file **is a customer list**."""
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    rows = csv_rows(_export(staff, "bookings", business=str(business.id)))

    assert rows[0]["passenger_id"] == str(booking.passenger_id)
    assert rows[0]["passenger_email"] == booking.passenger.email


def test_every_export_is_audit_logged() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)

    _export(staff, "revenue", business=str(business.id))

    with platform_staff_bypass():
        entries = list(AuditLog.objects.filter(action="analytics.export"))
    assert len(entries) == 1
    assert entries[0].actor_id == staff.id
    assert entries[0].metadata["resource"] == "revenue"
    assert entries[0].metadata["business_id"] == str(business.id)


# --- manifest (docs/specs/18-manifest-and-staff-booking.md slice 1) ---------


def test_a_manifest_export_names_its_trip_rather_than_a_period() -> None:
    """Five departures downloaded in a row must not all arrive as
    `integra-manifest-all.csv`."""
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    booking, _intent = pay_a_booking(client, business, amount="900.00", idempotency_key="mf-name")

    response = _export(staff, "manifest", trip=str(booking.trip_id))

    disposition = response.headers["Content-Disposition"]
    assert str(booking.trip.service_date) in disposition
    assert str(booking.trip_id)[:8] in disposition
    assert "-all.csv" not in disposition


def test_a_manifest_export_with_no_trip_is_a_400_naming_the_parameter() -> None:
    """Not an empty file, and not every ticket the Client has ever
    issued: a manifest is bounded by a trip, and one with no trip is a
    different question rather than a bigger export."""
    client = ClientFactory()
    business_for(client)
    staff = ClientStaffUserFactory(client=client)

    response = _export(staff, "manifest")

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "?trip=" in response.data["detail"]


def test_a_pay_as_you_go_manifest_exports_journeys_not_an_empty_file() -> None:
    """The hole the spec's own non-goal missed. `bookings` filtered by
    trip covers a prepaid departure; a pay-as-you-go one has no Booking
    rows at all, so that export of it is a blank file — the worst
    possible answer to "print me who is aboard"."""
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        trip = TripFactory(
            client=client,
            route=route,
            business=business,
            fare_collection_mode=Business.FareCollectionMode.PAY_AS_YOU_GO,
        )
        passenger = PassengerUserFactory(client=client)
        FareJourney.objects.create(
            client=client,
            business=business,
            trip=trip,
            passenger=passenger,
            credential=TapCredentialFactory(client=client, passenger=passenger),
            board_stop=stop_a,
            alight_stop=stop_b,
            status=FareJourney.Status.CLOSED,
            amount="300.00",
            currency=business.currency,
            boarded_at=timezone.now(),
            alighted_at=timezone.now(),
        )

    rows = csv_rows(_export(staff, "manifest", trip=str(trip.id)))

    assert len(rows) == 1
    assert rows[0]["kind"] == "pay_as_you_go"
    assert rows[0]["board_stop"] == stop_a.name
    assert rows[0]["fare"] == "300.00"
    # A journey has no booking to reference and no seat to sit in.
    assert rows[0]["reference"] == ""
    assert rows[0]["seat_number"] == ""


def test_a_manifest_export_carries_no_passenger_email() -> None:
    """Mirrors the screen, which is gated to name and seat. That the
    `bookings` export does carry one is a pre-existing inconsistency, not
    licence to repeat it."""
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    booking, _intent = pay_a_booking(client, business, amount="900.00", idempotency_key="mf-pii")

    body = csv_text(_export(staff, "manifest", trip=str(booking.trip_id)))

    assert booking.passenger.email not in body
