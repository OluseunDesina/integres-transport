"""The status lifecycle — docs/specs/17-incidents.md.

`apps.incidents.services.transition_incident` is the sole write path for
`Incident.status`, so this file is where the whole matrix is proved:
every legal move, every illegal one, both reopen paths, and the
same-status no-op.
"""

import itertools

import pytest
from django.urls import reverse
from rest_framework import status as http

from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import ClientStaffUserFactory

from ..models import Incident, IncidentActivity
from ..services import IllegalTransition, transition_incident
from .factories import IncidentFactory
from .helpers import auth_client, business_for

pytestmark = pytest.mark.django_db

S = Incident.Status

#: Restated here rather than imported from the service. A test that
#: imports the table it is testing proves only that the table equals
#: itself; written out, this is a second, independent statement of the
#: spec's own lifecycle prose.
LEGAL = {
    (S.OPEN, S.ACKNOWLEDGED),
    (S.OPEN, S.INVESTIGATING),
    (S.OPEN, S.RESOLVED),
    (S.ACKNOWLEDGED, S.INVESTIGATING),
    (S.ACKNOWLEDGED, S.RESOLVED),
    (S.INVESTIGATING, S.RESOLVED),
    (S.RESOLVED, S.CLOSED),
    (S.RESOLVED, S.INVESTIGATING),
    (S.CLOSED, S.INVESTIGATING),
}


def _incident(status: str = S.OPEN) -> tuple[Incident, object]:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        incident = IncidentFactory(client=client, business=business, status=status)
    return incident, staff


def _activities(incident: Incident) -> list[IncidentActivity]:
    with tenant_context(str(incident.client_id)):
        return list(IncidentActivity.objects.filter(incident=incident).order_by("created_at"))


# --- the full matrix ---------------------------------------------------


@pytest.mark.parametrize(("from_status", "to_status"), sorted(LEGAL))
def test_every_legal_transition_is_accepted(from_status: str, to_status: str) -> None:
    incident, staff = _incident(from_status)

    with tenant_context(str(incident.client_id)):
        updated = transition_incident(incident=incident, to_status=to_status, actor=staff)

    assert updated.status == to_status


@pytest.mark.parametrize(
    ("from_status", "to_status"),
    sorted(
        pair
        for pair in itertools.product(S.values, S.values)
        if pair not in LEGAL and pair[0] != pair[1]
    ),
)
def test_every_illegal_transition_is_refused(from_status: str, to_status: str) -> None:
    """Includes `closed -> open`, the spec's own named example. Generated
    from the product of the two enums minus the legal set, so a status
    added later is covered without anyone remembering to add a case."""
    incident, staff = _incident(from_status)

    with tenant_context(str(incident.client_id)), pytest.raises(IllegalTransition):
        transition_incident(incident=incident, to_status=to_status, actor=staff)


@pytest.mark.parametrize("current", S.values)
def test_transitioning_to_the_current_status_is_a_no_op(current: str) -> None:
    """A no-op success, not a 409 and not a second trail entry.

    A double-submitted form must not grow a duplicate history, and
    answering 409 would make an action that looks idempotent fail for no
    operational reason.
    """
    incident, staff = _incident(current)

    with tenant_context(str(incident.client_id)):
        transition_incident(incident=incident, to_status=current, actor=staff)

    assert incident.status == current
    assert _activities(incident) == []


# --- resolved_at -------------------------------------------------------


def test_resolving_stamps_resolved_at() -> None:
    incident, staff = _incident(S.INVESTIGATING)

    with tenant_context(str(incident.client_id)):
        transition_incident(incident=incident, to_status=S.RESOLVED, actor=staff)

    assert incident.resolved_at is not None


def test_closing_a_resolved_incident_keeps_its_resolved_at() -> None:
    """`resolved -> closed` is filing, not un-resolving. Clearing the
    timestamp there would lose the only record of when the fault was
    actually fixed."""
    incident, staff = _incident(S.RESOLVED)

    with tenant_context(str(incident.client_id)):
        transition_incident(incident=incident, to_status=S.RESOLVED, actor=staff)
        transition_incident(incident=incident, to_status=S.INVESTIGATING, actor=staff)
        transition_incident(incident=incident, to_status=S.RESOLVED, actor=staff)
        resolved_at = incident.resolved_at
        transition_incident(incident=incident, to_status=S.CLOSED, actor=staff)

    assert incident.resolved_at == resolved_at


@pytest.mark.parametrize("from_status", [S.RESOLVED, S.CLOSED])
def test_reopening_clears_resolved_at(from_status: str) -> None:
    """A fault reported fixed and still broken is the normal case, so
    both terminal-ish statuses reopen to `investigating` rather than
    forcing a duplicate record that loses the history."""
    incident, staff = _incident(S.INVESTIGATING)

    with tenant_context(str(incident.client_id)):
        transition_incident(incident=incident, to_status=S.RESOLVED, actor=staff)
        if from_status == S.CLOSED:
            transition_incident(incident=incident, to_status=S.CLOSED, actor=staff)
        assert incident.resolved_at is not None

        transition_incident(incident=incident, to_status=S.INVESTIGATING, actor=staff)

    assert incident.status == S.INVESTIGATING
    assert incident.resolved_at is None


# --- the trail ---------------------------------------------------------


def test_each_transition_writes_one_ordered_activity_row_naming_the_actor() -> None:
    incident, staff = _incident(S.OPEN)

    with tenant_context(str(incident.client_id)):
        transition_incident(incident=incident, to_status=S.ACKNOWLEDGED, actor=staff)
        transition_incident(
            incident=incident, to_status=S.INVESTIGATING, actor=staff, note="Sent a technician."
        )
        transition_incident(incident=incident, to_status=S.RESOLVED, actor=staff)

    trail = _activities(incident)
    assert [(row.from_status, row.to_status) for row in trail] == [
        (S.OPEN, S.ACKNOWLEDGED),
        (S.ACKNOWLEDGED, S.INVESTIGATING),
        (S.INVESTIGATING, S.RESOLVED),
    ]
    assert {row.kind for row in trail} == {IncidentActivity.Kind.STATUS_CHANGE}
    assert {row.actor_id for row in trail} == {staff.id}
    assert trail[1].note == "Sent a technician."


def test_a_transition_writes_an_audit_log_row_alongside_the_trail() -> None:
    """Two records on purpose. `IncidentActivity` renders in the product;
    `AuditLog` is the append-only compliance record nobody sees. Neither
    substitutes for the other."""
    from apps.core.models import AuditLog

    incident, staff = _incident(S.OPEN)

    with tenant_context(str(incident.client_id)):
        transition_incident(incident=incident, to_status=S.ACKNOWLEDGED, actor=staff)
        audit = AuditLog.objects.filter(
            action="incident.transitioned", target_id=str(incident.id)
        ).first()

    assert audit is not None
    assert audit.metadata["to_status"] == S.ACKNOWLEDGED


# --- over HTTP ---------------------------------------------------------


def test_the_transition_endpoint_returns_the_incident_with_its_trail() -> None:
    incident, staff = _incident(S.OPEN)

    response = auth_client(staff).post(
        reverse("incident-transition", kwargs={"pk": str(incident.id)}),
        {"status": S.ACKNOWLEDGED, "note": "Seen."},
        format="json",
    )

    assert response.status_code == http.HTTP_200_OK
    assert response.data["status"] == S.ACKNOWLEDGED
    assert len(response.data["activities"]) == 1
    assert response.data["activities"][0]["note"] == "Seen."


def test_an_illegal_transition_over_http_is_a_409() -> None:
    incident, staff = _incident(S.CLOSED)

    response = auth_client(staff).post(
        reverse("incident-transition", kwargs={"pk": str(incident.id)}),
        {"status": S.OPEN},
        format="json",
    )

    assert response.status_code == http.HTTP_409_CONFLICT


def test_patch_cannot_move_status_and_says_where_to_go_instead() -> None:
    """Silently dropping an undeclared `status` would leave an operator
    believing they had closed an incident they had not."""
    incident, staff = _incident(S.OPEN)

    response = auth_client(staff).patch(
        reverse("incident-detail", kwargs={"pk": str(incident.id)}),
        {"status": S.RESOLVED},
        format="json",
    )

    assert response.status_code == http.HTTP_400_BAD_REQUEST
    assert "/incidents/{id}/transition/" in response.data["detail"]
    with tenant_context(str(incident.client_id)):
        incident.refresh_from_db()
    assert incident.status == S.OPEN
