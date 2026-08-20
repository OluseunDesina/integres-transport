"""Fat-service layer for apps.notifications — see
docs/specs/9-notifications.md, and this phase's own plan for the two
deviations from that spec's original draft:

1. **Weekly re-nag, not fire-once-ever**, for the two compliance-expiry
   types. `Notification.expiry_snapshot` + `notified_for_date` (not in
   the original spec draft) are what make this possible without a
   second tracking model — see `_notify_compliance_recipients` below.
2. **A KYC/KYB-submission trigger** for `super-admin-app`, event-driven
   (not swept) — `notify_kyc_submitted`/`notify_kyb_submitted`, called
   directly from `apps.clients.services.submit_kyc_document` /
   `apps.businesses.services.submit_kyb_document`.

Both sweep functions run under `apps.core.rls.platform_staff_bypass()`
and use `.all_objects` throughout — a Celery task has no ambient
tenancy context, the same requirement every existing periodic job in
this codebase (`apps.scheduling.tasks.generate_trips`,
`apps.seating.tasks.expire_seat_holds`) already follows.
"""

import uuid
from datetime import date, timedelta

from django.conf import settings
from django.db.models import Q
from django.utils import timezone

from apps.core.audit import record_audit_event
from apps.core.rls import platform_staff_bypass
from apps.fleet.models import Driver, Vehicle
from apps.identity.models import User
from apps.ticketing.models import Ticket

from .models import Notification


def _eligible_client_staff(client_id: uuid.UUID) -> list[User]:
    """Every Staff/Manager/Owner user at the target's Client — there is
    no per-Business staff assignment in this codebase
    (`identity.User.client` is the only scoping FK), so "at the
    Business" (the original spec draft's Edge case 4 wording) is really
    "at the Client" that owns the Business."""
    # User isn't a BaseModel subclass (ADR-0003: client is nullable, for
    # platform staff) and carries no RLS policy of its own — `.objects`
    # is already the plain, unscoped manager, no bypass equivalent
    # needed.
    return list(User.objects.filter(client_id=client_id, is_client_staff=True))


def _notify_compliance_recipients(
    *,
    client_id: uuid.UUID,
    notification_type: str,
    related_object_type: str,
    related_object_id: uuid.UUID,
    expiry_value: date,
    title: str,
    body: str,
) -> int:
    """One target (a Driver's license, one of a Vehicle's two compliance
    dates), fanned out to every eligible recipient at its Client. Fires
    when there's no prior notification for this (recipient, type,
    target) at all, or the prior one's `expiry_snapshot` no longer
    matches (the date was renewed, then re-entered the warning window —
    a fresh cycle), or `LICENSE_EXPIRY_RENOTIFY_DAYS` have passed since
    the prior one's `notified_for_date` (still unresolved, nag again).
    `get_or_create` keyed on the exact uniqueness constraint is what
    makes a same-day double sweep run a safe no-op regardless of this
    function's own read-then-write gap."""
    today = date.today()
    created = 0
    for recipient in _eligible_client_staff(client_id):
        latest = (
            Notification.all_objects.filter(
                recipient=recipient,
                notification_type=notification_type,
                related_object_type=related_object_type,
                related_object_id=related_object_id,
            )
            .order_by("-created_at")
            .first()
        )
        due = (
            latest is None
            or latest.expiry_snapshot != expiry_value
            or (today - latest.notified_for_date).days >= settings.LICENSE_EXPIRY_RENOTIFY_DAYS
        )
        if not due:
            continue
        _, was_created = Notification.all_objects.get_or_create(
            recipient=recipient,
            notification_type=notification_type,
            related_object_type=related_object_type,
            related_object_id=related_object_id,
            notified_for_date=today,
            defaults={
                "client_id": client_id,
                "title": title,
                "body": body,
                "expiry_snapshot": expiry_value,
            },
        )
        if was_created:
            created += 1
    return created


def sweep_expiring_compliance() -> int:
    """Driver license / Vehicle insurance / Vehicle roadworthiness —
    fires within `LICENSE_EXPIRY_WARNING_DAYS` of expiry (including
    already-expired), regardless of `is_active` (Edge case 3: a
    deactivated record could be reactivated without the underlying
    compliance issue actually being resolved — deactivation doesn't
    imply "no longer our problem")."""
    threshold = date.today() + timedelta(days=settings.LICENSE_EXPIRY_WARNING_DAYS)
    created = 0
    with platform_staff_bypass():
        for driver in Driver.all_objects.filter(
            license_expires_at__isnull=False, license_expires_at__lte=threshold
        ):
            license_expires_at = driver.license_expires_at
            assert license_expires_at is not None  # guaranteed by the isnull=False filter above
            created += _notify_compliance_recipients(
                client_id=driver.client_id,
                notification_type=Notification.NotificationType.LICENSE_EXPIRING,
                related_object_type="Driver",
                related_object_id=driver.id,
                expiry_value=license_expires_at,
                title=f"{driver.name}'s license is expiring",
                body=(
                    f"{driver.name}'s driver's license expires on "
                    f"{license_expires_at.isoformat()}."
                ),
            )
        for vehicle in Vehicle.all_objects.filter(
            Q(insurance_expires_at__isnull=False, insurance_expires_at__lte=threshold)
            | Q(roadworthiness_expires_at__isnull=False, roadworthiness_expires_at__lte=threshold)
        ):
            if (
                vehicle.insurance_expires_at is not None
                and vehicle.insurance_expires_at <= threshold
            ):
                created += _notify_compliance_recipients(
                    client_id=vehicle.client_id,
                    notification_type=Notification.NotificationType.INSURANCE_EXPIRING,
                    related_object_type="Vehicle",
                    related_object_id=vehicle.id,
                    expiry_value=vehicle.insurance_expires_at,
                    title=f"{vehicle.registration_number}'s insurance is expiring",
                    body=(
                        f"{vehicle.registration_number}'s insurance expires on "
                        f"{vehicle.insurance_expires_at.isoformat()}."
                    ),
                )
            if (
                vehicle.roadworthiness_expires_at is not None
                and vehicle.roadworthiness_expires_at <= threshold
            ):
                created += _notify_compliance_recipients(
                    client_id=vehicle.client_id,
                    notification_type=Notification.NotificationType.ROADWORTHINESS_EXPIRING,
                    related_object_type="Vehicle",
                    related_object_id=vehicle.id,
                    expiry_value=vehicle.roadworthiness_expires_at,
                    title=f"{vehicle.registration_number}'s roadworthiness certificate is expiring",
                    body=(
                        f"{vehicle.registration_number}'s roadworthiness certificate expires on "
                        f"{vehicle.roadworthiness_expires_at.isoformat()}."
                    ),
                )
        record_audit_event(
            actor=None,
            action="notifications.compliance_swept",
            client_id=None,
            notifications_created=created,
        )
    return created


def sweep_unused_tickets() -> int:
    """Unlike the compliance sweep, this fires **once ever** per
    Ticket — a Ticket's own status is what naturally resolves this (it
    moves to `boarded`/`expired`/`revoked` and stops matching the
    filter below), so there's no renewal concept to re-nag about, and
    no `expiry_snapshot` involved."""
    threshold = timezone.now() + timedelta(
        hours=settings.TICKET_UNUSED_REMINDER_HOURS_BEFORE_DEPARTURE
    )
    today = date.today()
    created = 0
    with platform_staff_bypass():
        tickets = Ticket.all_objects.filter(
            status=Ticket.Status.ISSUED, trip__scheduled_departure_at__lte=threshold
        ).select_related("booking", "trip")
        for ticket in tickets:
            already_notified = Notification.all_objects.filter(
                recipient=ticket.booking.passenger,
                notification_type=Notification.NotificationType.TICKET_UNUSED_REMINDER,
                related_object_type="Ticket",
                related_object_id=ticket.id,
            ).exists()
            if already_notified:
                continue
            _, was_created = Notification.all_objects.get_or_create(
                recipient=ticket.booking.passenger,
                notification_type=Notification.NotificationType.TICKET_UNUSED_REMINDER,
                related_object_type="Ticket",
                related_object_id=ticket.id,
                notified_for_date=today,
                defaults={
                    "client_id": ticket.client_id,
                    "title": "Don't forget to use your ticket",
                    "body": (
                        "Your ticket for the trip departing "
                        f"{ticket.trip.scheduled_departure_at:%Y-%m-%d %H:%M} UTC "
                        "hasn't been used yet."
                    ),
                },
            )
            if was_created:
                created += 1
        record_audit_event(
            actor=None,
            action="notifications.ticket_reminder_swept",
            client_id=None,
            notifications_created=created,
        )
    return created


def _notify_platform_staff(
    *,
    notification_type: str,
    related_object_type: str,
    related_object_id: uuid.UUID,
    client_id: uuid.UUID,
    title: str,
    body: str,
) -> int:
    today = date.today()
    created = 0
    with platform_staff_bypass():
        for recipient in User.objects.filter(is_platform_staff=True):
            _, was_created = Notification.all_objects.get_or_create(
                recipient=recipient,
                notification_type=notification_type,
                related_object_type=related_object_type,
                related_object_id=related_object_id,
                notified_for_date=today,
                defaults={"client_id": client_id, "title": title, "body": body},
            )
            if was_created:
                created += 1
    return created


def notify_kyc_submitted(*, client_id: uuid.UUID, client_name: str, document_id: uuid.UUID) -> int:
    """Called directly from `apps.clients.services.submit_kyc_document` —
    event-driven, not swept. One `Notification` per platform-staff
    user (Edge case 4's "every ... user gets their own row" reasoning,
    extended to platform staff)."""
    return _notify_platform_staff(
        notification_type=Notification.NotificationType.KYC_DOCUMENT_SUBMITTED,
        related_object_type="KycDocument",
        related_object_id=document_id,
        client_id=client_id,
        title="New KYC document submitted",
        body=f"{client_name} submitted a new KYC document for review.",
    )


def notify_kyb_submitted(
    *, client_id: uuid.UUID, business_name: str, document_id: uuid.UUID
) -> int:
    """Called directly from `apps.businesses.services.submit_kyb_document`
    — mirrors `notify_kyc_submitted` exactly."""
    return _notify_platform_staff(
        notification_type=Notification.NotificationType.KYB_DOCUMENT_SUBMITTED,
        related_object_type="KybDocument",
        related_object_id=document_id,
        client_id=client_id,
        title="New KYB document submitted",
        body=f"{business_name} submitted a new KYB document for review.",
    )


def mark_notification_read(*, notification: Notification) -> Notification:
    if notification.read_at is None:
        notification.read_at = timezone.now()
        notification.save(update_fields=["read_at"])
    return notification


def mark_all_notifications_read(*, recipient: User) -> int:
    # Same read-side branch as NotificationMineView/NotificationReadView:
    # a platform-staff recipient's own notifications can span several
    # different Clients (they aren't the client-owner of the rows they
    # receive — see this module's own top-of-file docstring), so
    # `.objects` (client_id = current session's client) would silently
    # match zero rows for them. `.all_objects` relies on RLS's own
    # `client_id = session OR is_platform_staff` policy for the real
    # boundary, same as every other IsPlatformStaff-reachable cross-client
    # read in this codebase.
    manager = Notification.all_objects if recipient.is_platform_staff else Notification.objects
    return manager.filter(recipient=recipient, read_at__isnull=True).update(read_at=timezone.now())
