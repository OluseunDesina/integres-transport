from decimal import Decimal

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business
from apps.clients.tests.factories import ClientFactory
from apps.core.idempotency import IdempotencyKeyConflict
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.fares.tests.factories import FareRuleFactory, FareSegmentRuleFactory
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.models import Trip
from apps.scheduling.tests.factories import TripFactory

from ..models import FareJourney, TapEvent
from ..services import (
    CredentialInactive,
    InvalidAlightStop,
    NoOpenJourney,
    OpenJourneyExists,
    StopNotOnRoute,
    TripNotOpenForTaps,
    TripNotTapAndGo,
    UnknownToken,
    issue_credential,
    record_tap,
)

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _tap_and_go_trip_with_three_stops(client: object):  # type: ignore[no-untyped-def]
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        route = RouteFactory(client=client)
        stop_1 = StopFactory(client=client, business=route.business)
        stop_2 = StopFactory(client=client, business=route.business)
        stop_3 = StopFactory(client=client, business=route.business)
        RouteStopFactory(client=client, route=route, stop=stop_1, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_2, sequence=2)
        RouteStopFactory(client=client, route=route, stop=stop_3, sequence=3)
        trip = TripFactory(
            client=client,
            route=route,
            business=route.business,
            booking_mode=Business.BookingMode.TAP_AND_GO,
        )
    return trip, stop_1, stop_2, stop_3


# --- record_tap: board (service-level) --------------------------------


def test_record_tap_board_opens_a_journey_and_records_the_tap() -> None:
    client = ClientFactory()
    trip, stop_1, _stop_2, _stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        credential, token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )
        tap_event = record_tap(
            trip=trip, token=token, tap_type="board", stop=stop_1, idempotency_key="board-1"
        )
        journey = FareJourney.objects.get(pk=tap_event.journey_id)

    assert tap_event.tap_type == TapEvent.TapType.BOARD
    assert journey.status == FareJourney.Status.OPEN
    assert journey.board_stop_id == stop_1.id
    assert journey.passenger_id == credential.passenger_id
    entry = AuditLog.objects.get(action="fare_journey.opened")
    assert entry.target_id == str(journey.id)


def test_record_tap_board_rejects_a_second_open_journey_for_the_same_passenger() -> None:
    client = ClientFactory()
    trip, stop_1, _stop_2, _stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        credential, token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )
        record_tap(trip=trip, token=token, tap_type="board", stop=stop_1, idempotency_key="a")
        with pytest.raises(OpenJourneyExists):
            record_tap(trip=trip, token=token, tap_type="board", stop=stop_1, idempotency_key="b")


def test_record_tap_board_rejects_an_unknown_token() -> None:
    client = ClientFactory()
    trip, stop_1, _stop_2, _stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)), pytest.raises(UnknownToken):
        record_tap(
            trip=trip, token="not-a-real-token", tap_type="board", stop=stop_1, idempotency_key="x"
        )


def test_record_tap_board_rejects_a_revoked_credential() -> None:
    client = ClientFactory()
    trip, stop_1, _stop_2, _stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        credential, token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )
        credential.is_active = False
        credential.save(update_fields=["is_active"])
        with pytest.raises(CredentialInactive):
            record_tap(trip=trip, token=token, tap_type="board", stop=stop_1, idempotency_key="x")


def test_record_tap_rejects_a_reservation_mode_trip() -> None:
    client = ClientFactory()
    trip, stop_1, _stop_2, _stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        trip.booking_mode = Business.BookingMode.RESERVATION
        trip.save(update_fields=["booking_mode"])
        credential, token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )
        with pytest.raises(TripNotTapAndGo):
            record_tap(trip=trip, token=token, tap_type="board", stop=stop_1, idempotency_key="x")


def test_record_tap_rejects_a_completed_trip() -> None:
    client = ClientFactory()
    trip, stop_1, _stop_2, _stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        trip.status = Trip.Status.COMPLETED
        trip.save(update_fields=["status"])
        credential, token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )
        with pytest.raises(TripNotOpenForTaps):
            record_tap(trip=trip, token=token, tap_type="board", stop=stop_1, idempotency_key="x")


def test_record_tap_board_rejects_a_stop_not_on_the_route() -> None:
    client = ClientFactory()
    trip, _stop_1, _stop_2, _stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        foreign_stop = StopFactory(client=client, business=trip.business)
        credential, token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )
        with pytest.raises(StopNotOnRoute):
            record_tap(
                trip=trip, token=token, tap_type="board", stop=foreign_stop, idempotency_key="x"
            )


# --- record_tap: alight (service-level) --------------------------------


def test_record_tap_alight_closes_the_journey_with_the_flat_fare() -> None:
    client = ClientFactory()
    trip, stop_1, _stop_2, stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="150.00")
        credential, token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )
        record_tap(trip=trip, token=token, tap_type="board", stop=stop_1, idempotency_key="board")
        tap_event = record_tap(
            trip=trip, token=token, tap_type="alight", stop=stop_3, idempotency_key="alight"
        )
        journey = FareJourney.objects.get(pk=tap_event.journey_id)

    assert journey.status == FareJourney.Status.CLOSED
    assert journey.amount == Decimal("150.00")
    assert journey.currency == trip.business.currency
    assert journey.fare_rule_id is not None
    entry = AuditLog.objects.get(action="fare_journey.closed")
    assert entry.metadata["amount"] == "150.00"


def test_record_tap_alight_closes_the_journey_with_the_per_segment_fare() -> None:
    client = ClientFactory()
    trip, stop_1, stop_2, _stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        business = Business.objects.get(pk=trip.business_id)
        business.fare_pricing_mode = Business.FarePricingMode.PER_SEGMENT
        business.save(update_fields=["fare_pricing_mode"])
        FareSegmentRuleFactory(
            client=client,
            route=trip.route,
            business=business,
            from_stop=stop_1,
            to_stop=stop_2,
            amount="80.00",
        )
        credential, token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="nfc", label=""
        )
        fresh_trip = Trip.objects.get(pk=trip.id)
        record_tap(
            trip=fresh_trip, token=token, tap_type="board", stop=stop_1, idempotency_key="board"
        )
        fresh_trip = Trip.objects.get(pk=trip.id)
        tap_event = record_tap(
            trip=fresh_trip, token=token, tap_type="alight", stop=stop_2, idempotency_key="alight"
        )
        journey = FareJourney.objects.get(pk=tap_event.journey_id)

    assert journey.amount == Decimal("80.00")
    assert journey.fare_segment_rule_id is not None


def test_record_tap_alight_with_no_fare_configured_flags_needs_review_but_persists_the_tap() -> (
    None
):
    client = ClientFactory()
    trip, stop_1, _stop_2, stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        credential, token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )
        record_tap(trip=trip, token=token, tap_type="board", stop=stop_1, idempotency_key="board")
        tap_event = record_tap(
            trip=trip, token=token, tap_type="alight", stop=stop_3, idempotency_key="alight"
        )
        journey = FareJourney.objects.get(pk=tap_event.journey_id)

    # The alight TapEvent IS persisted (unlike edge cases 2-4 below) —
    # spec edge case 5: the passenger already physically rode the
    # vehicle, so the tap itself is not rejected.
    assert tap_event.tap_type == TapEvent.TapType.ALIGHT
    assert journey.status == FareJourney.Status.NEEDS_REVIEW
    assert journey.amount is None
    assert journey.fare_rule_id is None
    assert journey.fare_segment_rule_id is None


def test_record_tap_alight_rejects_the_same_stop_as_boarding_without_persisting_a_tap() -> None:
    client = ClientFactory()
    trip, stop_1, _stop_2, _stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        credential, token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )
        record_tap(trip=trip, token=token, tap_type="board", stop=stop_1, idempotency_key="board")
        before = TapEvent.objects.count()
        with pytest.raises(InvalidAlightStop):
            record_tap(
                trip=trip, token=token, tap_type="alight", stop=stop_1, idempotency_key="alight"
            )
        assert TapEvent.objects.count() == before
        journey = FareJourney.objects.get(passenger=credential.passenger)
        assert journey.status == FareJourney.Status.OPEN


def test_record_tap_alight_rejects_a_stop_earlier_than_boarding() -> None:
    client = ClientFactory()
    trip, _stop_1, stop_2, stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        credential, token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )
        record_tap(trip=trip, token=token, tap_type="board", stop=stop_3, idempotency_key="board")
        with pytest.raises(InvalidAlightStop):
            record_tap(
                trip=trip, token=token, tap_type="alight", stop=stop_2, idempotency_key="alight"
            )
        journey = FareJourney.objects.get(passenger=credential.passenger)
        assert journey.status == FareJourney.Status.OPEN


def test_record_tap_alight_with_no_open_journey_raises_and_persists_nothing() -> None:
    client = ClientFactory()
    trip, _stop_1, _stop_2, stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        credential, token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )
        with pytest.raises(NoOpenJourney):
            record_tap(
                trip=trip, token=token, tap_type="alight", stop=stop_3, idempotency_key="alight"
            )
        assert TapEvent.objects.count() == 0
        assert FareJourney.objects.count() == 0


# --- record_tap: idempotency --------------------------------------------


def test_record_tap_replay_with_the_same_key_and_body_returns_the_original() -> None:
    client = ClientFactory()
    trip, stop_1, _stop_2, _stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        credential, token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )
        first = record_tap(
            trip=trip, token=token, tap_type="board", stop=stop_1, idempotency_key="replay"
        )
        second = record_tap(
            trip=trip, token=token, tap_type="board", stop=stop_1, idempotency_key="replay"
        )
        assert first.id == second.id
        assert TapEvent.objects.count() == 1


def test_record_tap_raises_conflict_when_the_same_key_is_reused_for_a_different_request() -> None:
    client = ClientFactory()
    trip, stop_1, stop_2, _stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        credential, token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )
        record_tap(trip=trip, token=token, tap_type="board", stop=stop_1, idempotency_key="dupe")
        with pytest.raises(IdempotencyKeyConflict):
            record_tap(
                trip=trip, token=token, tap_type="board", stop=stop_2, idempotency_key="dupe"
            )


# --- POST /trips/{trip_id}/taps/ endpoint -------------------------------


def test_tap_record_endpoint_requires_the_tapngo_record_permission() -> None:
    client = ClientFactory()
    trip, stop_1, _stop_2, _stop_3 = _tap_and_go_trip_with_three_stops(client)
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).post(
        reverse("tap-record", kwargs={"trip_id": str(trip.id)}),
        {"token": "irrelevant", "tap_type": "board", "stop_id": str(stop_1.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="endpoint-1",
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_tap_record_endpoint_requires_the_idempotency_key_header() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_1, _stop_2, _stop_3 = _tap_and_go_trip_with_three_stops(client)

    response = _auth_client(staff).post(
        reverse("tap-record", kwargs={"trip_id": str(trip.id)}),
        {"token": "irrelevant", "tap_type": "board", "stop_id": str(stop_1.id)},
        format="json",
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_staff_can_record_a_full_board_and_alight_flow_via_the_endpoint() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_1, _stop_2, stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="60.00")
        _credential, token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )

    api = _auth_client(staff)
    board = api.post(
        reverse("tap-record", kwargs={"trip_id": str(trip.id)}),
        {"token": token, "tap_type": "board", "stop_id": str(stop_1.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="e2e-board",
    )
    alight = api.post(
        reverse("tap-record", kwargs={"trip_id": str(trip.id)}),
        {"token": token, "tap_type": "alight", "stop_id": str(stop_3.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="e2e-alight",
    )

    assert board.status_code == status.HTTP_201_CREATED
    assert board.data["journey"]["status"] == "open"
    assert alight.status_code == status.HTTP_201_CREATED
    assert alight.data["journey"]["status"] == "closed"
    assert alight.data["journey"]["amount"] == "60.00"


def test_tap_record_endpoint_returns_404_for_an_unknown_token() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_1, _stop_2, _stop_3 = _tap_and_go_trip_with_three_stops(client)

    response = _auth_client(staff).post(
        reverse("tap-record", kwargs={"trip_id": str(trip.id)}),
        {"token": "nonexistent", "tap_type": "board", "stop_id": str(stop_1.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="unknown-token",
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_tap_record_endpoint_returns_409_for_a_second_open_journey() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_1, _stop_2, _stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        _credential, token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )

    api = _auth_client(staff)
    api.post(
        reverse("tap-record", kwargs={"trip_id": str(trip.id)}),
        {"token": token, "tap_type": "board", "stop_id": str(stop_1.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="first-board",
    )
    response = api.post(
        reverse("tap-record", kwargs={"trip_id": str(trip.id)}),
        {"token": token, "tap_type": "board", "stop_id": str(stop_1.id)},
        format="json",
        HTTP_IDEMPOTENCY_KEY="second-board",
    )
    assert response.status_code == status.HTTP_409_CONFLICT


# --- GET /fare-journeys/ (staff) ----------------------------------------


def test_fare_journey_list_requires_the_tapngo_view_permission() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).get(reverse("fare-journey-list"))
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_staff_with_tapngo_view_can_list_journeys_filtered_by_trip_and_status() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_1, _stop_2, stop_3 = _tap_and_go_trip_with_three_stops(client)
    other_trip, other_1, _other_2, other_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
        FareRuleFactory(
            client=client, route=other_trip.route, business=other_trip.business, amount="50.00"
        )
        _credential_a, token_a = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )
        _credential_b, token_b = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )
        record_tap(trip=trip, token=token_a, tap_type="board", stop=stop_1, idempotency_key="a1")
        matching = record_tap(
            trip=trip, token=token_a, tap_type="alight", stop=stop_3, idempotency_key="a2"
        )
        record_tap(
            trip=other_trip, token=token_b, tap_type="board", stop=other_1, idempotency_key="b1"
        )
        record_tap(
            trip=other_trip, token=token_b, tap_type="alight", stop=other_3, idempotency_key="b2"
        )

    response = _auth_client(staff).get(reverse("fare-journey-list"), {"trip": str(trip.id)})

    assert response.status_code == status.HTTP_200_OK
    assert [row["id"] for row in response.data["results"]] == [str(matching.journey_id)]


def test_fare_journey_list_query_count_does_not_scale_with_journey_count(
    django_assert_max_num_queries,
) -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_1, _stop_2, stop_3 = _tap_and_go_trip_with_three_stops(client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
        for index in range(5):
            _credential, token = issue_credential(
                passenger=PassengerUserFactory(client=client), channel="qr", label=""
            )
            record_tap(
                trip=trip,
                token=token,
                tap_type="board",
                stop=stop_1,
                idempotency_key=f"board-{index}",
            )
            record_tap(
                trip=trip,
                token=token,
                tap_type="alight",
                stop=stop_3,
                idempotency_key=f"alight-{index}",
            )

    with django_assert_max_num_queries(12):
        response = _auth_client(staff).get(reverse("fare-journey-list"))
    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["results"]) == 5


# --- GET /fare-journeys/mine/ --------------------------------------------


def test_fare_journeys_mine_lists_only_the_callers_own_journeys() -> None:
    client = ClientFactory()
    trip, stop_1, _stop_2, stop_3 = _tap_and_go_trip_with_three_stops(client)
    passenger_a = PassengerUserFactory(client=client)
    passenger_b = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="40.00")
        _credential_a, token_a = issue_credential(passenger=passenger_a, channel="qr", label="")
        _credential_b, token_b = issue_credential(passenger=passenger_b, channel="qr", label="")
        record_tap(trip=trip, token=token_a, tap_type="board", stop=stop_1, idempotency_key="ma")
        own = record_tap(
            trip=trip, token=token_a, tap_type="alight", stop=stop_3, idempotency_key="ma2"
        )
        record_tap(trip=trip, token=token_b, tap_type="board", stop=stop_1, idempotency_key="mb")
        record_tap(trip=trip, token=token_b, tap_type="alight", stop=stop_3, idempotency_key="mb2")

    response = _auth_client(passenger_a).get(reverse("fare-journey-mine"))

    assert response.status_code == status.HTTP_200_OK
    assert [row["id"] for row in response.data["results"]] == [str(own.journey_id)]
