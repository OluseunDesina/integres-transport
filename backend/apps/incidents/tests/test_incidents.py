"""Incidents — model, endpoints, filters, visibility and permissions.

See docs/specs/17-incidents.md. The lifecycle lives in
`test_incident_transitions.py`; the raw-SQL RLS probe in
`test_incidents_rls.py`.
"""

import datetime
from decimal import Decimal

import pytest
from django.db import IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone
from rest_framework import status as http
from rest_framework.test import APIClient

from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import (
    ClientStaffUserFactory,
    PassengerUserFactory,
)
from apps.notifications.models import Notification

from ..models import Incident, IncidentActivity
from ..services import (
    add_incident_note,
    assign_incident,
    create_incident,
    report_incident,
    update_incident,
)
from .factories import IncidentFactory
from .helpers import auth_client, business_for, passenger_client, stop_for, trip_for

pytestmark = pytest.mark.django_db

LIST_URL = reverse("incident-list-create")
REPORT_URL = reverse("incident-report")
MINE_URL = reverse("incident-mine")


def _create_body(business, **overrides):  # type: ignore[no-untyped-def]
    body = {
        "business": str(business.id),
        "title": "Validator on bus 12 is dead",
        "category": Incident.Category.HARDWARE,
        "description": "Card reader shows no lights.",
    }
    body.update(overrides)
    return body


def _report_body(**overrides):  # type: ignore[no-untyped-def]
    body = {
        "category": Incident.Category.HARDWARE,
        "description": "The reader would not scan my code.",
    }
    body.update(overrides)
    return body


# --- model ---------------------------------------------------------------


def test_both_models_declare_their_own_ordering() -> None:
    """Asserted directly, because both declare their own `Meta` and a
    subclass that does inherits *none* of `BaseModel.Meta`'s options.
    `identity.Role` and `identity.User` each shipped unordered
    pagination — a real bug — through exactly this gap."""
    assert Incident._meta.ordering == ["-created_at"]
    assert IncidentActivity._meta.ordering == ["created_at"]


def test_a_created_incident_gets_a_quotable_reference() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)

    with tenant_context(str(client.id)):
        incident = create_incident(
            business=business,
            reported_by=staff,
            idempotency_key="k1",
            title="Broken reader",
            category=Incident.Category.HARDWARE,
        )

    assert incident.reference.startswith("INC-")
    assert len(incident.reference) == 10
    # Crockford's base32: nothing that can be misheard down a phone line.
    assert not set(incident.reference[4:]) & set("ILOU")


def test_the_reference_is_unique_per_business() -> None:
    client = ClientFactory()
    business = business_for(client)

    with tenant_context(str(client.id)):
        IncidentFactory(client=client, business=business, reference="INC-SAME01")
        with pytest.raises(IntegrityError), transaction.atomic():
            IncidentFactory(client=client, business=business, reference="INC-SAME01")


def test_the_same_reference_may_exist_under_a_different_business() -> None:
    """Scoped per Business, not globally: the reference is only ever
    quoted in the context of one operator."""
    client = ClientFactory()
    first = business_for(client)
    second = business_for(client)

    with tenant_context(str(client.id)):
        IncidentFactory(client=client, business=first, reference="INC-SAME02")
        IncidentFactory(client=client, business=second, reference="INC-SAME02")

    assert True  # no IntegrityError is the assertion


def test_a_reference_collision_is_retried_rather_than_raised(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """The unique constraint is the backstop, not the user-facing
    outcome. Forced here by pinning the generator to one value for the
    first call, since a real 32^6 collision is not reproducible."""
    from .. import services

    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)

    with tenant_context(str(client.id)):
        IncidentFactory(client=client, business=business, reference="INC-CLASH")

        values = iter(["INC-CLASH", "INC-UNIQUE"])
        monkeypatch.setattr(services, "_generate_reference", lambda: next(values))
        incident = create_incident(
            business=business,
            reported_by=staff,
            idempotency_key="k-clash",
            title="Second one",
            category=Incident.Category.OTHER,
        )

    assert incident.reference == "INC-UNIQUE"


# --- operator creation ----------------------------------------------------


def test_an_operator_can_file_an_incident() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)

    response = auth_client(staff).post(
        LIST_URL, _create_body(business), format="json", HTTP_IDEMPOTENCY_KEY="k1"
    )

    assert response.status_code == http.HTTP_201_CREATED
    assert response.data["source"] == Incident.Source.OPERATOR
    assert response.data["status"] == Incident.Status.OPEN
    assert response.data["severity"] == Incident.Severity.MEDIUM
    assert response.data["reported_by"] == staff.id


def test_source_is_forced_and_cannot_be_claimed_in_the_body() -> None:
    """A request that says `source=passenger` is not honoured — the
    field is not on the create serializer at all, and the service sets
    it."""
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)

    response = auth_client(staff).post(
        LIST_URL,
        _create_body(business, source=Incident.Source.PASSENGER),
        format="json",
        HTTP_IDEMPOTENCY_KEY="k1",
    )

    assert response.data["source"] == Incident.Source.OPERATOR


def test_creating_without_an_idempotency_key_is_a_400() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)

    response = auth_client(staff).post(LIST_URL, _create_body(business), format="json")

    assert response.status_code == http.HTTP_400_BAD_REQUEST


def test_a_replayed_create_returns_the_original_and_files_nothing_new() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    api = auth_client(staff)
    body = _create_body(business)

    first = api.post(LIST_URL, body, format="json", HTTP_IDEMPOTENCY_KEY="replay")
    second = api.post(LIST_URL, body, format="json", HTTP_IDEMPOTENCY_KEY="replay")

    assert first.status_code == second.status_code == http.HTTP_201_CREATED
    assert first.data["id"] == second.data["id"]
    with tenant_context(str(client.id)):
        assert Incident.objects.count() == 1


def test_the_same_key_with_a_different_body_is_a_409() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    api = auth_client(staff)

    api.post(LIST_URL, _create_body(business), format="json", HTTP_IDEMPOTENCY_KEY="k")
    conflict = api.post(
        LIST_URL,
        _create_body(business, title="Something else entirely"),
        format="json",
        HTTP_IDEMPOTENCY_KEY="k",
    )

    assert conflict.status_code == http.HTTP_409_CONFLICT


def test_a_trip_belonging_to_a_different_business_is_refused() -> None:
    """Cross-*Client* references are already impossible through the
    tenant-scoped managers; cross-*Business* ones would not be."""
    client = ClientFactory()
    business = business_for(client)
    other_business = business_for(client)
    trip = trip_for(client, other_business)
    staff = ClientStaffUserFactory(client=client)

    response = auth_client(staff).post(
        LIST_URL,
        _create_body(business, trip=str(trip.id)),
        format="json",
        HTTP_IDEMPOTENCY_KEY="k1",
    )

    assert response.status_code == http.HTTP_400_BAD_REQUEST
    assert "trip" in response.data


def test_an_incident_records_its_location_exactly_as_supplied() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)

    response = auth_client(staff).post(
        LIST_URL,
        _create_body(business, latitude="6.524379", longitude="3.379206"),
        format="json",
        HTTP_IDEMPOTENCY_KEY="k1",
    )

    assert Decimal(response.data["latitude"]) == Decimal("6.524379")
    assert Decimal(response.data["longitude"]) == Decimal("3.379206")


# --- passenger reporting --------------------------------------------------


def test_a_passenger_can_report_with_no_trip_route_or_vehicle() -> None:
    """The spec's own edge case: a passenger on a platform reporting a
    broken reader may know none of them."""
    client = ClientFactory()
    business = business_for(client)
    passenger = PassengerUserFactory(client=client)

    response = passenger_client(passenger).post(
        REPORT_URL,
        _report_body(business=str(business.id)),
        format="json",
        HTTP_IDEMPOTENCY_KEY="p1",
    )

    assert response.status_code == http.HTTP_201_CREATED
    assert response.data["reference"].startswith("INC-")


def test_a_passenger_report_takes_its_business_from_the_trip() -> None:
    client = ClientFactory()
    business = business_for(client)
    trip = trip_for(client, business)
    passenger = PassengerUserFactory(client=client)

    response = passenger_client(passenger).post(
        REPORT_URL,
        _report_body(trip=str(trip.id)),
        format="json",
        HTTP_IDEMPOTENCY_KEY="p1",
    )

    assert response.status_code == http.HTTP_201_CREATED
    with tenant_context(str(client.id)):
        assert Incident.objects.get(pk=response.data["id"]).business_id == business.id


def test_a_report_with_neither_business_nor_trip_is_refused() -> None:
    client = ClientFactory()
    business_for(client)
    passenger = PassengerUserFactory(client=client)

    response = passenger_client(passenger).post(
        REPORT_URL, _report_body(), format="json", HTTP_IDEMPOTENCY_KEY="p1"
    )

    assert response.status_code == http.HTTP_400_BAD_REQUEST
    assert "business" in response.data


def test_a_passenger_report_is_sourced_passenger_and_medium_severity() -> None:
    """Severity is forced. A passenger able to declare their own report
    critical would be a one-tap way to ring every operator's bell."""
    client = ClientFactory()
    business = business_for(client)
    passenger = PassengerUserFactory(client=client)

    response = passenger_client(passenger).post(
        REPORT_URL,
        _report_body(business=str(business.id), severity=Incident.Severity.CRITICAL),
        format="json",
        HTTP_IDEMPOTENCY_KEY="p1",
    )

    with tenant_context(str(client.id)):
        incident = Incident.objects.get(pk=response.data["id"])
    assert incident.source == Incident.Source.PASSENGER
    assert incident.severity == Incident.Severity.MEDIUM


def test_a_titleless_report_gets_a_readable_title_from_its_category() -> None:
    """A queue of untitled rows is the same as no queue."""
    client = ClientFactory()
    business = business_for(client)
    passenger = PassengerUserFactory(client=client)

    response = passenger_client(passenger).post(
        REPORT_URL,
        _report_body(business=str(business.id), category=Incident.Category.GPS),
        format="json",
        HTTP_IDEMPOTENCY_KEY="p1",
    )

    assert response.data["title"] == "Passenger report: GPS / location"


def test_a_replayed_report_returns_the_original() -> None:
    """A passenger on a flaky platform connection tapping Report twice
    must not file two incidents."""
    client = ClientFactory()
    business = business_for(client)
    passenger = PassengerUserFactory(client=client)
    api = passenger_client(passenger)
    body = _report_body(business=str(business.id))

    first = api.post(REPORT_URL, body, format="json", HTTP_IDEMPOTENCY_KEY="p-replay")
    second = api.post(REPORT_URL, body, format="json", HTTP_IDEMPOTENCY_KEY="p-replay")

    assert first.data["id"] == second.data["id"]
    with tenant_context(str(client.id)):
        assert Incident.objects.count() == 1


def test_reporting_without_an_idempotency_key_is_a_400() -> None:
    client = ClientFactory()
    business = business_for(client)
    passenger = PassengerUserFactory(client=client)

    response = passenger_client(passenger).post(
        REPORT_URL, _report_body(business=str(business.id)), format="json"
    )

    assert response.status_code == http.HTTP_400_BAD_REQUEST


# --- the visibility rule --------------------------------------------------


def test_my_reports_omit_every_internal_field() -> None:
    """Asserted by **key absence**, not by a shape guess. Staff
    discussion of a safety report is not passenger-facing, and this is
    the assertion that would fail if someone widened the serializer."""
    client = ClientFactory()
    business = business_for(client)
    passenger = PassengerUserFactory(client=client)
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        incident = IncidentFactory(
            client=client,
            business=business,
            source=Incident.Source.PASSENGER,
            reported_by=passenger,
            assigned_to=staff,
            resolution_notes="Replaced the unit. Driver was at fault.",
        )
        add_incident_note(incident=incident, actor=staff, note="Internal: driver spoken to.")

    response = passenger_client(passenger).get(MINE_URL)

    assert response.status_code == http.HTTP_200_OK
    row = response.data["results"][0]
    for leaked in ("assigned_to", "resolution_notes", "activities", "severity", "source"):
        assert leaked not in row, f"{leaked} is visible to the reporting passenger"
    assert row["reference"] == incident.reference


def test_my_reports_show_only_my_own() -> None:
    client = ClientFactory()
    business = business_for(client)
    mine = PassengerUserFactory(client=client)
    theirs = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        IncidentFactory(client=client, business=business, reported_by=mine)
        IncidentFactory(client=client, business=business, reported_by=theirs)

    response = passenger_client(mine).get(MINE_URL)

    assert response.data["count"] == 1


def test_the_report_response_is_the_passenger_shape_not_the_staff_one() -> None:
    """The reporter must not learn who an incident was assigned to just
    because they filed it."""
    client = ClientFactory()
    business = business_for(client)
    passenger = PassengerUserFactory(client=client)

    response = passenger_client(passenger).post(
        REPORT_URL,
        _report_body(business=str(business.id)),
        format="json",
        HTTP_IDEMPOTENCY_KEY="p1",
    )

    assert "assigned_to" not in response.data
    assert "resolution_notes" not in response.data


# --- detail, notes and assignment ----------------------------------------


def test_the_detail_view_carries_the_trail_and_the_list_does_not() -> None:
    """Not a stylistic split: a nested trail on a paginated list is one
    extra query per row."""
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        incident = IncidentFactory(client=client, business=business)
        add_incident_note(incident=incident, actor=staff, note="Looked at it.")
    api = auth_client(staff)

    detail = api.get(reverse("incident-detail", kwargs={"pk": str(incident.id)}))
    listed = api.get(LIST_URL)

    assert len(detail.data["activities"]) == 1
    assert "activities" not in listed.data["results"][0]


def test_a_note_appends_to_the_trail() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        incident = IncidentFactory(client=client, business=business)

    response = auth_client(staff).post(
        reverse("incident-note", kwargs={"pk": str(incident.id)}),
        {"note": "Part ordered."},
        format="json",
    )

    assert response.status_code == http.HTTP_201_CREATED
    assert response.data["kind"] == IncidentActivity.Kind.NOTE
    assert response.data["actor_email"] == staff.email


def test_assignment_writes_its_own_trail_entry() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    assignee = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        incident = IncidentFactory(client=client, business=business)

    response = auth_client(staff).patch(
        reverse("incident-detail", kwargs={"pk": str(incident.id)}),
        {"assigned_to": str(assignee.id)},
        format="json",
    )

    assert response.data["assigned_to"] == assignee.id
    assert response.data["activities"][0]["kind"] == IncidentActivity.Kind.ASSIGNMENT


def test_assigning_the_same_person_twice_writes_one_trail_entry() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    assignee = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        incident = IncidentFactory(client=client, business=business)
        assign_incident(incident=incident, assignee=assignee, actor=staff)
        assign_incident(incident=incident, assignee=assignee, actor=staff)
        assert IncidentActivity.objects.filter(incident=incident).count() == 1


def test_assigning_another_clients_user_is_refused() -> None:
    """`identity.User` is **not** a `BaseModel` (docs/adr/0003) and
    `User.objects` is the plain unscoped manager, so the explicit Client
    filter in `_resolve_staff_user` is the only thing standing between
    an operator and another Client's staff. The spec claims the
    tenant-scoped manager handles this; it does not exist for `User`."""
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    outsider = ClientStaffUserFactory(client=ClientFactory())
    with tenant_context(str(client.id)):
        incident = IncidentFactory(client=client, business=business)

    response = auth_client(staff).patch(
        reverse("incident-detail", kwargs={"pk": str(incident.id)}),
        {"assigned_to": str(outsider.id)},
        format="json",
    )

    assert response.status_code == http.HTTP_400_BAD_REQUEST
    assert "assigned_to" in response.data


def test_editing_writes_an_audit_row_naming_the_changed_fields() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        incident = IncidentFactory(client=client, business=business)

    auth_client(staff).patch(
        reverse("incident-detail", kwargs={"pk": str(incident.id)}),
        {"title": "Renamed", "resolution_notes": "Swapped the unit."},
        format="json",
    )

    with tenant_context(str(client.id)):
        audit = AuditLog.objects.filter(
            action="incident.updated", target_id=str(incident.id)
        ).first()
    assert audit is not None
    assert audit.metadata["fields"] == ["resolution_notes", "title"]


# --- filters ---------------------------------------------------------------


def test_each_filter_narrows_and_they_compose() -> None:
    client = ClientFactory()
    business = business_for(client)
    other = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        IncidentFactory(
            client=client,
            business=business,
            category=Incident.Category.SAFETY,
            severity=Incident.Severity.CRITICAL,
            status=Incident.Status.OPEN,
        )
        IncidentFactory(
            client=client,
            business=business,
            category=Incident.Category.HARDWARE,
            severity=Incident.Severity.LOW,
            status=Incident.Status.CLOSED,
        )
        IncidentFactory(client=client, business=other, category=Incident.Category.SAFETY)
    api = auth_client(staff)

    assert api.get(LIST_URL).data["count"] == 3
    assert api.get(LIST_URL, {"business": str(business.id)}).data["count"] == 2
    assert api.get(LIST_URL, {"category": "safety"}).data["count"] == 2
    assert api.get(LIST_URL, {"severity": "critical"}).data["count"] == 1
    assert api.get(LIST_URL, {"status": "closed"}).data["count"] == 1
    assert api.get(LIST_URL, {"source": "passenger"}).data["count"] == 0
    composed = api.get(LIST_URL, {"business": str(business.id), "category": "safety"})
    assert composed.data["count"] == 1


def test_open_only_means_the_three_unfinished_statuses() -> None:
    """Shares `OPEN_STATUSES` with the dashboard's own count, so the
    queue and the stat above it cannot disagree about what open means."""
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        for value in Incident.Status.values:
            IncidentFactory(client=client, business=business, status=value)

    response = auth_client(staff).get(LIST_URL, {"open_only": "true"})

    assert response.data["count"] == 3


def test_the_list_is_not_silently_truncated_to_a_default_period() -> None:
    """A record list is bounded by its own pagination, never by an
    aggregate's rolling window. `GET /payments/` spent two specs
    silently unable to find a two-month-old payment through exactly this
    mistake (docs/specs/16-operational-analytics.md, slice 4)."""
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        old = IncidentFactory(client=client, business=business)
        Incident.objects.filter(pk=old.pk).update(
            created_at=timezone.now() - datetime.timedelta(days=200)
        )

    assert auth_client(staff).get(LIST_URL).data["count"] == 1


def test_the_date_window_narrows_on_both_sides_independently() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        old = IncidentFactory(client=client, business=business)
        Incident.objects.filter(pk=old.pk).update(
            created_at=timezone.now() - datetime.timedelta(days=30)
        )
        IncidentFactory(client=client, business=business)
    api = auth_client(staff)
    today = timezone.now().date()

    assert api.get(LIST_URL, {"date_from": today.isoformat()}).data["count"] == 1
    assert (
        api.get(
            LIST_URL, {"date_to": (today - datetime.timedelta(days=1)).isoformat()}
        ).data["count"]
        == 1
    )


def test_a_reversed_date_range_is_a_400() -> None:
    client = ClientFactory()
    business_for(client)
    staff = ClientStaffUserFactory(client=client)

    response = auth_client(staff).get(
        LIST_URL, {"date_from": "2026-05-01", "date_to": "2026-04-01"}
    )

    assert response.status_code == http.HTTP_400_BAD_REQUEST


def test_search_matches_the_reference_title_and_device() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        IncidentFactory(
            client=client, business=business, title="Reader dark", device_reference="VLD-77"
        )
        IncidentFactory(client=client, business=business, title="Windscreen cracked")
    api = auth_client(staff)

    assert api.get(LIST_URL, {"search": "reader"}).data["count"] == 1
    assert api.get(LIST_URL, {"search": "VLD-77"}).data["count"] == 1
    assert api.get(LIST_URL, {"search": ""}).data["count"] == 2


def test_listing_costs_the_same_whether_there_is_one_row_or_twelve() -> None:
    """The property that actually matters, asserted directly rather than
    guessed at with a magic budget.

    A fixed maximum would drift with unrelated middleware changes and
    would still pass an N+1 that only shows up at scale. This compares
    two real requests instead: it fails the moment a row costs a query,
    which is what the six `select_related` joins the label fields depend
    on are for — and what a trail nested into the list serializer would
    reintroduce.
    """
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    trip = trip_for(client, business)
    stop = stop_for(client, business)

    def build(count: int) -> None:
        with tenant_context(str(client.id)):
            for _ in range(count):
                IncidentFactory(
                    client=client,
                    business=business,
                    trip=trip,
                    route=trip.route,
                    stop=stop,
                    reported_by=staff,
                    assigned_to=staff,
                )

    api = auth_client(staff)
    build(1)
    with CaptureQueriesContext(connection) as one_row:
        assert api.get(LIST_URL).status_code == http.HTTP_200_OK
    build(11)
    with CaptureQueriesContext(connection) as twelve_rows:
        assert api.get(LIST_URL).data["count"] == 12

    assert len(twelve_rows) == len(one_row)


# --- notifications ---------------------------------------------------------


def _notifications(client_id: str) -> list[Notification]:
    with tenant_context(str(client_id)):
        return list(Notification.objects.filter(related_object_type="Incident"))


def test_a_low_severity_incident_notifies_nobody() -> None:
    """A documented departure from the spec's "on create". Fan-out is one
    row *per staff user*, and hardware faults are both the highest-volume
    category and the one a single broken device can emit repeatedly. Low
    and medium reports still reach the queue and the dashboard count."""
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)

    with tenant_context(str(client.id)):
        create_incident(
            business=business,
            reported_by=staff,
            idempotency_key="k1",
            title="Torn seat cover",
            category=Incident.Category.VEHICLE,
            severity=Incident.Severity.LOW,
        )

    assert _notifications(str(client.id)) == []


def test_a_critical_incident_notifies_every_staff_user_once() -> None:
    client = ClientFactory()
    business = business_for(client)
    first = ClientStaffUserFactory(client=client)
    second = ClientStaffUserFactory(client=client)

    with tenant_context(str(client.id)):
        create_incident(
            business=business,
            reported_by=first,
            idempotency_key="k1",
            title="Brake failure",
            category=Incident.Category.SAFETY,
            severity=Incident.Severity.CRITICAL,
        )

    rows = _notifications(str(client.id))
    assert {row.recipient_id for row in rows} == {first.id, second.id}
    assert {row.notification_type for row in rows} == {
        Notification.NotificationType.INCIDENT_REPORTED
    }


def test_escalating_to_critical_notifies_but_a_downgrade_does_not() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        incident = IncidentFactory(
            client=client, business=business, severity=Incident.Severity.LOW
        )

        update_incident(
            incident=incident, actor=staff, changes={"severity": Incident.Severity.MEDIUM}
        )
        assert _notifications(str(client.id)) == []

        update_incident(
            incident=incident, actor=staff, changes={"severity": Incident.Severity.CRITICAL}
        )

    rows = _notifications(str(client.id))
    assert [row.notification_type for row in rows] == [
        Notification.NotificationType.INCIDENT_ESCALATED
    ]


def test_a_severity_change_writes_its_own_trail_entry() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        incident = IncidentFactory(
            client=client, business=business, severity=Incident.Severity.LOW
        )
        update_incident(
            incident=incident, actor=staff, changes={"severity": Incident.Severity.HIGH}
        )
        kinds = list(
            IncidentActivity.objects.filter(incident=incident).values_list("kind", flat=True)
        )

    assert kinds == [IncidentActivity.Kind.SEVERITY_CHANGE]


def test_a_same_day_repeat_for_one_incident_cannot_double_notify() -> None:
    """Keyed on the existing
    `unique_notification_per_recipient_type_target_per_day` constraint,
    so this holds regardless of the caller's own idempotency."""
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        incident = IncidentFactory(
            client=client, business=business, severity=Incident.Severity.LOW
        )
        update_incident(
            incident=incident, actor=staff, changes={"severity": Incident.Severity.CRITICAL}
        )
        update_incident(
            incident=incident, actor=staff, changes={"severity": Incident.Severity.LOW}
        )
        update_incident(
            incident=incident, actor=staff, changes={"severity": Incident.Severity.CRITICAL}
        )

    assert len(_notifications(str(client.id))) == 1


# --- permissions ------------------------------------------------------------


def test_a_passenger_cannot_reach_any_staff_endpoint() -> None:
    client = ClientFactory()
    business = business_for(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        incident = IncidentFactory(client=client, business=business)
    api = passenger_client(passenger)

    assert api.get(LIST_URL).status_code == http.HTTP_403_FORBIDDEN
    assert (
        api.get(reverse("incident-detail", kwargs={"pk": str(incident.id)})).status_code
        == http.HTTP_403_FORBIDDEN
    )
    assert (
        api.post(
            reverse("incident-transition", kwargs={"pk": str(incident.id)}),
            {"status": "acknowledged"},
            format="json",
        ).status_code
        == http.HTTP_403_FORBIDDEN
    )


def test_the_staff_preset_can_both_view_and_manage_incidents() -> None:
    """Granted to Staff on purpose, unlike `analytics.view`. Frontline
    staff are exactly who notices a broken reader; gating reporting
    behind a manager role would guarantee nothing gets reported."""
    client = ClientFactory()
    business = business_for(client)
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Staff"])
    api = auth_client(staff)

    assert api.get(LIST_URL).status_code == http.HTTP_200_OK
    created = api.post(
        LIST_URL, _create_body(business), format="json", HTTP_IDEMPOTENCY_KEY="k1"
    )
    assert created.status_code == http.HTTP_201_CREATED


def test_a_staff_user_with_no_role_is_blocked() -> None:
    client = ClientFactory()
    business_for(client)
    staff = ClientStaffUserFactory(client=client)
    staff.role = None
    staff.save(update_fields=["role"])

    assert auth_client(staff).get(LIST_URL).status_code == http.HTTP_403_FORBIDDEN


@pytest.mark.parametrize("url", [LIST_URL, REPORT_URL, MINE_URL])
def test_every_endpoint_requires_authentication(url: str) -> None:
    assert APIClient().get(url).status_code == http.HTTP_401_UNAUTHORIZED


# --- cross-client isolation (the mandatory set) ----------------------------


def test_another_clients_incidents_are_absent_from_the_list() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    business_b = business_for(client_b)
    with tenant_context(str(client_b.id)):
        IncidentFactory(client=client_b, business=business_b)
    staff_a = ClientStaffUserFactory(client=client_a)

    assert auth_client(staff_a).get(LIST_URL).data["count"] == 0


def test_a_clients_own_incidents_are_unaffected_by_a_neighbours() -> None:
    """The other half of the same guarantee: isolation must not be
    achieved by returning nothing to anybody."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    business_a = business_for(client_a)
    business_b = business_for(client_b)
    with tenant_context(str(client_a.id)):
        mine = IncidentFactory(client=client_a, business=business_a)
    with tenant_context(str(client_b.id)):
        IncidentFactory(client=client_b, business=business_b)
        IncidentFactory(client=client_b, business=business_b)
    staff_a = ClientStaffUserFactory(client=client_a)

    response = auth_client(staff_a).get(LIST_URL)

    assert response.data["count"] == 1
    assert response.data["results"][0]["reference"] == mine.reference


def test_another_clients_incident_detail_is_a_404_not_a_403() -> None:
    """Saying "forbidden" would confirm the record exists."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    business_b = business_for(client_b)
    with tenant_context(str(client_b.id)):
        incident_b = IncidentFactory(client=client_b, business=business_b)
    staff_a = ClientStaffUserFactory(client=client_a)
    api = auth_client(staff_a)
    detail = reverse("incident-detail", kwargs={"pk": str(incident_b.id)})

    assert api.get(detail).status_code == http.HTTP_404_NOT_FOUND
    assert api.patch(detail, {"title": "x"}, format="json").status_code == http.HTTP_404_NOT_FOUND
    assert (
        api.post(
            reverse("incident-transition", kwargs={"pk": str(incident_b.id)}),
            {"status": "acknowledged"},
            format="json",
        ).status_code
        == http.HTTP_404_NOT_FOUND
    )


def test_another_clients_business_as_a_query_param_is_a_400() -> None:
    """Silently returning an unfiltered list would be worse than a 400 —
    the caller would believe it had scoped and had not."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    business_b = business_for(client_b)
    staff_a = ClientStaffUserFactory(client=client_a)

    response = auth_client(staff_a).get(LIST_URL, {"business": str(business_b.id)})

    assert response.status_code == http.HTTP_400_BAD_REQUEST


def test_a_passenger_cannot_report_against_another_clients_trip() -> None:
    """RLS makes the trip unresolvable, so this is a 400 on the FK
    rather than a cross-tenant leak."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    business_b = business_for(client_b)
    trip_b = trip_for(client_b, business_b)
    passenger_a = PassengerUserFactory(client=client_a)

    response = passenger_client(passenger_a).post(
        REPORT_URL,
        _report_body(trip=str(trip_b.id)),
        format="json",
        HTTP_IDEMPOTENCY_KEY="p1",
    )

    assert response.status_code == http.HTTP_400_BAD_REQUEST
    assert "trip" in response.data


def test_reporting_incidents_does_not_leak_across_clients_in_mine() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    business_b = business_for(client_b)
    passenger_a = PassengerUserFactory(client=client_a)
    with tenant_context(str(client_b.id)):
        IncidentFactory(client=client_b, business=business_b, reported_by=passenger_a)

    assert passenger_client(passenger_a).get(MINE_URL).data["count"] == 0


def test_report_by_a_passenger_records_the_reporter() -> None:
    client = ClientFactory()
    business = business_for(client)
    passenger = PassengerUserFactory(client=client)

    with tenant_context(str(client.id)):
        incident = report_incident(
            business=business,
            reported_by=passenger,
            idempotency_key="p1",
            category=Incident.Category.GPS,
            description="Bus showed in the wrong place.",
        )

    assert incident.reported_by_id == passenger.id


# --- assignable users -------------------------------------------------------

ASSIGNABLE_URL = reverse("incident-assignable-users")


def test_assignable_users_reaches_manager_and_staff_not_just_owner() -> None:
    """The whole reason this endpoint exists. `GET /staff/` is gated on
    `staff.manage`, which only the Owner preset holds — so populating an
    assignee picker from it would 403 for exactly the people who hold
    `incidents.manage` and triage incidents."""
    client = ClientFactory()
    business_for(client)
    roles = create_default_roles(client)

    for preset in ("Owner", "Manager", "Staff"):
        user = ClientStaffUserFactory(client=client, role=roles[preset])
        response = auth_client(user).get(ASSIGNABLE_URL)
        assert response.status_code == http.HTTP_200_OK, preset


def test_the_old_staff_endpoint_really_is_closed_to_them() -> None:
    """Pins the premise. If `/staff/` ever opens up, this endpoint's
    justification changes and someone should notice here."""
    client = ClientFactory()
    roles = create_default_roles(client)
    manager = ClientStaffUserFactory(client=client, role=roles["Manager"])

    assert auth_client(manager).get(reverse("staff-list")).status_code == http.HTTP_403_FORBIDDEN


def test_assignable_users_lists_staff_and_excludes_passengers() -> None:
    client = ClientFactory()
    business_for(client)
    staff = ClientStaffUserFactory(client=client)
    colleague = ClientStaffUserFactory(client=client)
    passenger = PassengerUserFactory(client=client)

    response = auth_client(staff).get(ASSIGNABLE_URL)

    # The serialized id is a string; `user.id` is a UUID.
    ids = {str(row["id"]) for row in response.data["results"]}
    assert {str(staff.id), str(colleague.id)} <= ids
    assert str(passenger.id) not in ids


def test_assignable_users_carries_no_role_or_permission_data() -> None:
    """Narrower than `StaffSerializer` on purpose — choosing who to hand
    a broken reader to does not require reading everyone's permissions."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    row = auth_client(staff).get(ASSIGNABLE_URL).data["results"][0]

    assert set(row) == {"id", "email", "first_name", "last_name"}


def test_assignable_users_is_scoped_to_the_callers_client() -> None:
    """`User` is not a `BaseModel` and `User.objects` is the plain
    unscoped manager (docs/adr/0003), so the view's own `client` filter
    is the *only* thing scoping this. Both halves asserted."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    mine = ClientStaffUserFactory(client=client_a)
    theirs = ClientStaffUserFactory(client=client_b)

    ids = {str(row["id"]) for row in auth_client(mine).get(ASSIGNABLE_URL).data["results"]}

    assert str(mine.id) in ids
    assert str(theirs.id) not in ids


def test_assignable_users_requires_incidents_manage() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)

    assert passenger_client(passenger).get(ASSIGNABLE_URL).status_code == http.HTTP_403_FORBIDDEN
    assert APIClient().get(ASSIGNABLE_URL).status_code == http.HTTP_401_UNAUTHORIZED


# --- optional write fields --------------------------------------------------


def test_blank_optional_fields_may_be_omitted_entirely() -> None:
    """Regression for a types-only defect shipped in slice 1.

    `required=False` **with** `default=""` makes drf-spectacular emit the
    field as *required* in the generated `schema.ts` — the exact trap
    CLAUDE.md records. Five fields across three write serializers had it,
    so three frontend forms would have had to send `''` to satisfy the
    compiler. Asserted at the API rather than against the schema file,
    since that is where it has to be true.
    """
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    passenger = PassengerUserFactory(client=client)

    created = auth_client(staff).post(
        LIST_URL,
        {
            "business": str(business.id),
            "title": "No description, no device",
            "category": Incident.Category.OTHER,
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="k-min",
    )
    assert created.status_code == http.HTTP_201_CREATED
    assert created.data["description"] == ""
    assert created.data["device_reference"] == ""

    transitioned = auth_client(staff).post(
        reverse("incident-transition", kwargs={"pk": created.data["id"]}),
        {"status": Incident.Status.ACKNOWLEDGED},
        format="json",
    )
    assert transitioned.status_code == http.HTTP_200_OK

    reported = passenger_client(passenger).post(
        REPORT_URL,
        {"business": str(business.id), "category": "gps", "description": "Wrong place"},
        format="json",
        HTTP_IDEMPOTENCY_KEY="p-min",
    )
    assert reported.status_code == http.HTTP_201_CREATED
    assert reported.data["title"] == "Passenger report: GPS / location"
