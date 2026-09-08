"""Fat-service layer for apps.incidents — see docs/specs/17-incidents.md.

`transition_incident` is the **sole write path for `Incident.status`**.
The lifecycle is enforced here rather than in a serializer so that a
second caller — a future bulk action, a management command — cannot
reach an illegal state by going around the HTTP layer. `PATCH` refuses
`status` outright and says where to go instead.

Idempotency on both create paths follows
`apps.tapngo.services.record_tap`'s exact shape: look the key up first,
create the `IdempotencyKey` row inside the same `transaction.atomic()`
as the domain rows so a failed attempt memorizes nothing, and reconcile
the concurrent-duplicate race in an `IntegrityError` handler.
"""

from __future__ import annotations

import secrets
from decimal import Decimal
from typing import Any

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.businesses.models import Business
from apps.core.audit import record_audit_event
from apps.core.idempotency import IdempotencyKeyConflict, hash_request
from apps.core.models import IdempotencyKey
from apps.fleet.models import Driver, Vehicle
from apps.identity.models import User
from apps.network.models import Route, Stop
from apps.notifications.services import notify_incident_escalated, notify_incident_raised
from apps.scheduling.models import Trip

from .models import Incident, IncidentActivity

_CREATE_IDEMPOTENCY_ENDPOINT = "incidents.create"
_REPORT_IDEMPOTENCY_ENDPOINT = "incidents.report"

# Crockford's base32: no I, L, O or U, so a reference read aloud down a
# phone line cannot be transcribed as a different one. That is the whole
# point of `reference` existing beside a perfectly good UUID.
_REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_REFERENCE_LENGTH = 6
_REFERENCE_ATTEMPTS = 5
_REFERENCE_CONSTRAINT = "unique_incident_reference_per_business"

#: Severities that put a row in front of staff the moment it is created.
#: Deliberately not every create — `_eligible_client_staff` fans out one
#: notification row *per staff user*, and hardware faults are both the
#: highest-volume category and the one a single broken device can emit
#: repeatedly. A `low` report still reaches the queue and the dashboard
#: count; it just does not ring a bell for twenty people. A documented
#: departure from the spec's "on create".
_NOTIFYING_SEVERITIES = frozenset({Incident.Severity.HIGH, Incident.Severity.CRITICAL})

_S = Incident.Status

#: The whole lifecycle, in one place rather than scattered through
#: `if`s. Any non-closed status may jump straight to `resolved` (a
#: trivial incident should not need three clicks); `resolved`/`closed`
#: may be reopened to `investigating`, because a fault reported fixed and
#: still broken is the normal case and forcing a duplicate record loses
#: the history.
_ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    _S.OPEN: frozenset({_S.ACKNOWLEDGED, _S.INVESTIGATING, _S.RESOLVED}),
    _S.ACKNOWLEDGED: frozenset({_S.INVESTIGATING, _S.RESOLVED}),
    _S.INVESTIGATING: frozenset({_S.RESOLVED}),
    _S.RESOLVED: frozenset({_S.CLOSED, _S.INVESTIGATING}),
    _S.CLOSED: frozenset({_S.INVESTIGATING}),
}

#: Everything `PATCH /incidents/{id}/` may write. `status` is absent on
#: purpose and `update_incident` refuses it by name.
EDITABLE_FIELDS = frozenset(
    {
        "title",
        "description",
        "category",
        "severity",
        "trip",
        "route",
        "vehicle",
        "driver",
        "stop",
        "device_reference",
        "assigned_to",
        "latitude",
        "longitude",
        "resolution_notes",
    }
)


class IllegalTransition(Exception):
    """The requested status is not reachable from the current one —
    mapped to 409. Includes `closed -> open`; a closed incident can only
    be reopened to `investigating`."""


class StatusNotEditable(Exception):
    """A `PATCH` tried to set `status` — mapped to 400, naming the
    transition endpoint. Status is a lifecycle, not a field."""


# --- references ------------------------------------------------------------


def _generate_reference() -> str:
    body = "".join(secrets.choice(_REFERENCE_ALPHABET) for _ in range(_REFERENCE_LENGTH))
    return f"INC-{body}"


def _create_with_reference(**fields: Any) -> Incident:
    """Create an `Incident`, retrying on a reference collision.

    Each attempt gets its own nested `transaction.atomic()`: an
    `IntegrityError` poisons the surrounding transaction, so retrying
    without one would fail on the very next statement with
    `TransactionManagementError` rather than succeeding. Only a collision
    on this specific constraint is retried — anything else (a bad FK,
    say) propagates immediately rather than being tried five times and
    reported as if it were a collision.
    """
    for attempt in range(_REFERENCE_ATTEMPTS):
        try:
            with transaction.atomic():
                return Incident.objects.create(reference=_generate_reference(), **fields)
        except IntegrityError as exc:
            if _REFERENCE_CONSTRAINT not in str(exc) or attempt == _REFERENCE_ATTEMPTS - 1:
                raise
    raise AssertionError("unreachable: the final attempt either returns or raises")


# --- trail -----------------------------------------------------------------


def _record_activity(
    *,
    incident: Incident,
    actor: User | None,
    kind: str,
    note: str = "",
    from_status: str = "",
    to_status: str = "",
) -> IncidentActivity:
    return IncidentActivity.objects.create(
        client_id=incident.client_id,
        incident=incident,
        actor=actor,
        kind=kind,
        from_status=from_status,
        to_status=to_status,
        note=note,
    )


def activity_for(incident: Incident) -> list[IncidentActivity]:
    """The trail, oldest first. A `.filter()` rather than a reverse
    accessor, per this app's `related_name="+"` convention."""
    return list(
        IncidentActivity.objects.filter(incident=incident).select_related("actor").order_by(
            "created_at"
        )
    )


# --- creation --------------------------------------------------------------


def _incident_from_idempotency_record(record: IdempotencyKey) -> Incident:
    response_body: dict[str, Any] = record.response_body or {}
    return Incident.objects.get(pk=response_body["incident_id"])


def _create_incident(
    *,
    endpoint: str,
    idempotency_key: str,
    source: str,
    business: Business,
    reported_by: User,
    title: str,
    category: str,
    description: str,
    severity: str,
    trip: Trip | None,
    route: Route | None,
    vehicle: Vehicle | None,
    driver: Driver | None,
    stop: Stop | None,
    device_reference: str,
    assigned_to: User | None,
    latitude: Decimal | None,
    longitude: Decimal | None,
) -> Incident:
    request_hash = hash_request(
        {
            "business": str(business.id),
            "title": title,
            "category": category,
            "description": description,
            "severity": severity,
            "trip": str(trip.id) if trip else None,
            "route": str(route.id) if route else None,
            "vehicle": str(vehicle.id) if vehicle else None,
            "driver": str(driver.id) if driver else None,
            "stop": str(stop.id) if stop else None,
            "device_reference": device_reference,
            "assigned_to": str(assigned_to.id) if assigned_to else None,
            "latitude": str(latitude) if latitude is not None else None,
            "longitude": str(longitude) if longitude is not None else None,
        }
    )
    client_id = str(business.client_id)

    existing = IdempotencyKey.objects.filter(
        client_id=client_id, endpoint=endpoint, key=idempotency_key
    ).first()
    if existing is not None:
        if existing.request_hash != request_hash:
            raise IdempotencyKeyConflict(
                "This Idempotency-Key was already used for a different request."
            )
        return _incident_from_idempotency_record(existing)

    try:
        with transaction.atomic():
            incident = _create_with_reference(
                client_id=business.client_id,
                business=business,
                title=title,
                category=category,
                description=description,
                severity=severity,
                source=source,
                trip=trip,
                route=route,
                vehicle=vehicle,
                driver=driver,
                stop=stop,
                device_reference=device_reference,
                reported_by=reported_by,
                assigned_to=assigned_to,
                latitude=latitude,
                longitude=longitude,
            )
            IdempotencyKey.objects.create(
                client_id=client_id,
                endpoint=endpoint,
                key=idempotency_key,
                request_hash=request_hash,
                response_status=201,
                response_body={"incident_id": str(incident.id)},
            )
    except IntegrityError:
        # Reachable only for the IdempotencyKey race itself — a reference
        # collision is caught and retried inside `_create_with_reference`'s
        # own nested atomic block.
        record = IdempotencyKey.objects.get(
            client_id=client_id, endpoint=endpoint, key=idempotency_key
        )
        if record.request_hash != request_hash:
            raise IdempotencyKeyConflict(
                "This Idempotency-Key was already used for a different request."
            ) from None
        return _incident_from_idempotency_record(record)

    record_audit_event(
        actor=reported_by,
        action="incident.reported",
        target=incident,
        reference=incident.reference,
        source=source,
        severity=severity,
        category=category,
    )
    if severity in _NOTIFYING_SEVERITIES:
        notify_incident_raised(
            client_id=business.client_id,
            business_name=business.name,
            incident_id=incident.id,
            reference=incident.reference,
            title=incident.title,
            severity=severity,
        )
    return incident


def create_incident(
    *,
    business: Business,
    reported_by: User,
    idempotency_key: str,
    title: str,
    category: str,
    description: str = "",
    severity: str = Incident.Severity.MEDIUM,
    trip: Trip | None = None,
    route: Route | None = None,
    vehicle: Vehicle | None = None,
    driver: Driver | None = None,
    stop: Stop | None = None,
    device_reference: str = "",
    assigned_to: User | None = None,
    latitude: Decimal | None = None,
    longitude: Decimal | None = None,
) -> Incident:
    """`POST /incidents/` — operator-created. `source` is forced here,
    never taken from the request body."""
    return _create_incident(
        endpoint=_CREATE_IDEMPOTENCY_ENDPOINT,
        idempotency_key=idempotency_key,
        source=Incident.Source.OPERATOR,
        business=business,
        reported_by=reported_by,
        title=title,
        category=category,
        description=description,
        severity=severity,
        trip=trip,
        route=route,
        vehicle=vehicle,
        driver=driver,
        stop=stop,
        device_reference=device_reference,
        assigned_to=assigned_to,
        latitude=latitude,
        longitude=longitude,
    )


def passenger_report_title(*, category: str, title: str) -> str:
    """A passenger supplies a category and a description; a title is
    optional. Derived rather than left blank so the operator queue has
    something to read in its first column — a list of untitled rows is
    the same as no list."""
    if title:
        return title[:255]
    return f"Passenger report: {Incident.Category(category).label}"[:255]


def report_incident(
    *,
    business: Business,
    reported_by: User,
    idempotency_key: str,
    category: str,
    description: str,
    title: str = "",
    trip: Trip | None = None,
    route: Route | None = None,
    stop: Stop | None = None,
    vehicle: Vehicle | None = None,
    device_reference: str = "",
    latitude: Decimal | None = None,
    longitude: Decimal | None = None,
) -> Incident:
    """`POST /incidents/report/` — passenger-submitted.

    `source` and `severity` are both forced: a passenger does not get to
    declare their own report critical, which would be a trivial way to
    ring every operator's bell at will. Staff raise severity from the
    queue if it warrants it.

    No `driver` or `assigned_to`: a passenger has no way to identify a
    driver and no business assigning work to staff.
    """
    return _create_incident(
        endpoint=_REPORT_IDEMPOTENCY_ENDPOINT,
        idempotency_key=idempotency_key,
        source=Incident.Source.PASSENGER,
        business=business,
        reported_by=reported_by,
        title=passenger_report_title(category=category, title=title),
        category=category,
        description=description,
        severity=Incident.Severity.MEDIUM,
        trip=trip,
        route=route,
        vehicle=vehicle,
        driver=None,
        stop=stop,
        device_reference=device_reference,
        assigned_to=None,
        latitude=latitude,
        longitude=longitude,
    )


# --- lifecycle -------------------------------------------------------------


def transition_incident(
    *, incident: Incident, to_status: str, actor: User, note: str = ""
) -> Incident:
    """The only path that writes `Incident.status`.

    Transitioning to the status it already holds is a **no-op success
    writing no activity row** — a double-submitted form must not grow a
    duplicate trail, and answering 409 would make an idempotent-looking
    action fail for no operational reason.
    """
    if to_status == incident.status:
        return incident

    if to_status not in _ALLOWED_TRANSITIONS.get(incident.status, frozenset()):
        raise IllegalTransition(
            f"An incident that is {incident.get_status_display().lower()} cannot move to "
            f"{Incident.Status(to_status).label.lower()}."
        )

    from_status = incident.status
    update_fields = ["status"]
    incident.status = to_status

    if to_status == Incident.Status.RESOLVED:
        incident.resolved_at = timezone.now()
        update_fields.append("resolved_at")
    elif to_status == Incident.Status.INVESTIGATING and from_status in (
        Incident.Status.RESOLVED,
        Incident.Status.CLOSED,
    ):
        # A reopen, and *only* a reopen. Keying this on the origin alone
        # also caught `resolved -> closed`, which is filing rather than
        # un-resolving: that path must keep its timestamp, since it is
        # the only record of when the fault was actually fixed.
        incident.resolved_at = None
        update_fields.append("resolved_at")

    incident.save(update_fields=update_fields)
    _record_activity(
        incident=incident,
        actor=actor,
        kind=IncidentActivity.Kind.STATUS_CHANGE,
        from_status=from_status,
        to_status=to_status,
        note=note,
    )
    record_audit_event(
        actor=actor,
        action="incident.transitioned",
        target=incident,
        reference=incident.reference,
        from_status=from_status,
        to_status=to_status,
    )
    return incident


def assign_incident(*, incident: Incident, assignee: User | None, actor: User) -> Incident:
    """Assignment is its own trail entry, so "who was this handed to and
    when" survives independently of the status history."""
    assignee_id = assignee.id if assignee is not None else None
    if incident.assigned_to_id == assignee_id:
        return incident

    incident.assigned_to = assignee
    incident.save(update_fields=["assigned_to"])
    _record_activity(
        incident=incident,
        actor=actor,
        kind=IncidentActivity.Kind.ASSIGNMENT,
        note=f"Assigned to {assignee.email}" if assignee is not None else "Unassigned",
    )
    record_audit_event(
        actor=actor,
        action="incident.assigned",
        target=incident,
        reference=incident.reference,
        assigned_to=str(assignee_id) if assignee_id else None,
    )
    return incident


def add_incident_note(*, incident: Incident, actor: User, note: str) -> IncidentActivity:
    """An internal note. Never visible to the passenger who reported the
    incident — `/incidents/mine/` returns a different serializer that
    carries no trail at all."""
    activity = _record_activity(
        incident=incident, actor=actor, kind=IncidentActivity.Kind.NOTE, note=note
    )
    record_audit_event(
        actor=actor, action="incident.noted", target=incident, reference=incident.reference
    )
    return activity


def update_incident(
    *,
    incident: Incident,
    actor: User,
    changes: dict[str, Any],
    submitted_fields: set[str] | None = None,
) -> Incident:
    """`PATCH /incidents/{id}/` — editable fields only.

    `submitted_fields` is the raw key set of the request body, passed in
    so this function can refuse `status` *by name*. The update serializer
    does not declare `status` at all, so it never reaches `changes`, and
    silently dropping it would leave an operator believing they had
    closed an incident they had not. The rule lives here rather than in
    the serializer because it is a domain rule: a second caller must not
    be able to move status by going around `transition_incident`.
    """
    if submitted_fields and "status" in submitted_fields:
        raise StatusNotEditable(
            "Status cannot be changed here. POST to /incidents/{id}/transition/ instead."
        )

    assignee_given = "assigned_to" in changes
    assignee = changes.pop("assigned_to", None)

    previous_severity = incident.severity
    applied = [field for field in changes if field in EDITABLE_FIELDS]
    for field in applied:
        setattr(incident, field, changes[field])
    if applied:
        incident.save(update_fields=applied)

    if "severity" in applied and incident.severity != previous_severity:
        _record_activity(
            incident=incident,
            actor=actor,
            kind=IncidentActivity.Kind.SEVERITY_CHANGE,
            note=f"Severity {previous_severity} -> {incident.severity}",
        )
        # Only an *escalation* to critical rings a bell. A downgrade, or
        # a move between the lower three, is queue-visible and does not
        # need to reach twenty people's notification panels.
        if (
            incident.severity == Incident.Severity.CRITICAL
            and previous_severity != Incident.Severity.CRITICAL
        ):
            notify_incident_escalated(
                client_id=incident.client_id,
                incident_id=incident.id,
                reference=incident.reference,
                title=incident.title,
            )

    if applied:
        record_audit_event(
            actor=actor,
            action="incident.updated",
            target=incident,
            reference=incident.reference,
            fields=sorted(applied),
        )

    if assignee_given:
        assign_incident(incident=incident, assignee=assignee, actor=actor)

    return incident
