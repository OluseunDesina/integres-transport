"""apps.notifications — see docs/specs/9-notifications.md and this
phase's own plan for the weekly re-nag / KYC-KYB-trigger deviations
from that spec's original draft."""

import datetime
from datetime import date, timedelta

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.booking.services import mark_booking_paid
from apps.businesses.models import Business
from apps.businesses.services import submit_kyb_document
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.models import Client
from apps.clients.services import submit_kyc_document
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.fleet.tests.factories import DriverFactory, VehicleFactory
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory
from apps.payments.tests.booking_helpers import booking_with_a_held_seat
from apps.ticketing.models import Ticket

from ..models import Notification
from ..services import notify_kyc_submitted, sweep_expiring_compliance, sweep_unused_tickets
from .factories import NotificationFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    api_client = APIClient()
    api_client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api_client


def _platform_staff_auth_client(user: User) -> APIClient:
    # Platform staff sign in via the super-admin JWT audience — the
    # claim that actually matters for RLS/tenancy is is_platform_staff,
    # not which serializer minted the token, but ClientAdminTokenObtainSerializer
    # only ever issues tokens for is_client_staff users, so this needs a
    # distinct serializer.
    from apps.identity.serializers import SuperAdminTokenObtainSerializer

    token = SuperAdminTokenObtainSerializer.get_token(user)
    api_client = APIClient()
    api_client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api_client


def _platform_staff_user() -> User:
    return User.objects.create_user(
        email=f"platform-{User.objects.count()}@example.com",
        password="irrelevant-password-123",  # noqa: S106
        is_platform_staff=True,
        is_client_staff=False,
    )


# --- sweep_expiring_compliance() -------------------------------------------


def test_compliance_sweep_fires_within_the_warning_window() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        DriverFactory(client=client, license_expires_at=date.today() + timedelta(days=10))

    created = sweep_expiring_compliance()

    assert created == 1
    with tenant_context(str(client.id)):
        notification = Notification.objects.get(recipient=staff)
    assert notification.notification_type == Notification.NotificationType.LICENSE_EXPIRING


def test_compliance_sweep_does_not_fire_outside_the_warning_window() -> None:
    client = ClientFactory()
    ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        DriverFactory(client=client, license_expires_at=date.today() + timedelta(days=90))

    created = sweep_expiring_compliance()

    assert created == 0


def test_compliance_sweep_fires_for_an_already_expired_license_too() -> None:
    client = ClientFactory()
    ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        DriverFactory(client=client, license_expires_at=date.today() - timedelta(days=5))

    created = sweep_expiring_compliance()

    assert created == 1


def test_compliance_sweep_does_not_duplicate_on_a_same_day_rerun() -> None:
    client = ClientFactory()
    ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        DriverFactory(client=client, license_expires_at=date.today() + timedelta(days=10))

    first = sweep_expiring_compliance()
    second = sweep_expiring_compliance()

    assert first == 1
    assert second == 0
    with platform_staff_bypass():
        assert Notification.all_objects.filter(client_id=client.id).count() == 1


def test_compliance_sweep_renotifies_after_the_renotify_interval() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        DriverFactory(client=client, license_expires_at=date.today() + timedelta(days=10))

    sweep_expiring_compliance()
    with platform_staff_bypass():
        stale = Notification.all_objects.get(recipient=staff)
        eight_days_ago = timezone.now() - timedelta(days=8)
        Notification.all_objects.filter(id=stale.id).update(
            created_at=eight_days_ago, notified_for_date=eight_days_ago.date()
        )

    created = sweep_expiring_compliance()

    assert created == 1
    with platform_staff_bypass():
        assert Notification.all_objects.filter(client_id=client.id, recipient=staff).count() == 2


def test_compliance_sweep_does_not_renotify_before_the_renotify_interval() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        DriverFactory(client=client, license_expires_at=date.today() + timedelta(days=10))

    sweep_expiring_compliance()
    with platform_staff_bypass():
        stale = Notification.all_objects.get(recipient=staff)
        three_days_ago = timezone.now() - timedelta(days=3)
        Notification.all_objects.filter(id=stale.id).update(
            created_at=three_days_ago, notified_for_date=three_days_ago.date()
        )

    created = sweep_expiring_compliance()

    assert created == 0


def test_compliance_sweep_starts_a_fresh_cycle_immediately_when_the_expiry_date_changes() -> None:
    """A renewal (the expiry date moving) fires a new notification on
    the very next sweep run, even though the renotify interval (7 days)
    hasn't elapsed since the prior one — the whole point of tracking
    `expiry_snapshot`, not just elapsed time. The prior notification is
    backdated one day (not zero — two sweep runs never legitimately
    land on the same calendar day under this daily cron/beat cadence,
    and `notified_for_date` is a same-day dedup key, so a same-day
    second run here would collide with the first regardless of the
    value changing — a realistic scenario needs a day boundary between
    them, same as production)."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        driver = DriverFactory(client=client, license_expires_at=date.today() + timedelta(days=10))

    sweep_expiring_compliance()
    with platform_staff_bypass():
        stale = Notification.all_objects.get(recipient=staff)
        yesterday = timezone.now() - timedelta(days=1)
        Notification.all_objects.filter(id=stale.id).update(
            created_at=yesterday, notified_for_date=yesterday.date()
        )

    # Renewed, but the new date is *also* inside the warning window
    # (e.g. a short renewal) — a fresh cycle for a different expiry
    # value should still fire immediately, well before the 7-day
    # renotify interval would otherwise have elapsed.
    with tenant_context(str(client.id)):
        driver.license_expires_at = date.today() + timedelta(days=25)
        driver.save(update_fields=["license_expires_at"])

    created = sweep_expiring_compliance()

    assert created == 1
    with platform_staff_bypass():
        assert Notification.all_objects.filter(client_id=client.id, recipient=staff).count() == 2


def test_compliance_sweep_stops_firing_once_the_date_moves_outside_the_window() -> None:
    client = ClientFactory()
    ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        driver = DriverFactory(client=client, license_expires_at=date.today() + timedelta(days=10))

    sweep_expiring_compliance()

    with tenant_context(str(client.id)):
        driver.license_expires_at = date.today() + timedelta(days=365)
        driver.save(update_fields=["license_expires_at"])

    created = sweep_expiring_compliance()

    assert created == 0


def test_compliance_sweep_notifies_every_client_staff_user_at_the_client() -> None:
    client = ClientFactory()
    owner = ClientStaffUserFactory(client=client)
    manager = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        VehicleFactory(client=client, insurance_expires_at=date.today() + timedelta(days=5))

    created = sweep_expiring_compliance()

    assert created == 2
    with platform_staff_bypass():
        recipients = set(
            Notification.all_objects.filter(client_id=client.id).values_list(
                "recipient_id", flat=True
            )
        )
    assert recipients == {owner.id, manager.id}


def test_compliance_sweep_fires_independently_for_insurance_and_roadworthiness() -> None:
    client = ClientFactory()
    ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        VehicleFactory(
            client=client,
            insurance_expires_at=date.today() + timedelta(days=5),
            roadworthiness_expires_at=date.today() + timedelta(days=5),
        )

    created = sweep_expiring_compliance()

    assert created == 2
    with platform_staff_bypass():
        types = set(
            Notification.all_objects.filter(client_id=client.id).values_list(
                "notification_type", flat=True
            )
        )
    assert types == {
        Notification.NotificationType.INSURANCE_EXPIRING,
        Notification.NotificationType.ROADWORTHINESS_EXPIRING,
    }


def test_compliance_sweep_fires_regardless_of_is_active() -> None:
    """Edge case 3: deactivation doesn't imply the compliance issue is
    resolved."""
    client = ClientFactory()
    ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        DriverFactory(
            client=client,
            license_expires_at=date.today() + timedelta(days=5),
            is_active=False,
        )

    created = sweep_expiring_compliance()

    assert created == 1


# --- sweep_unused_tickets() -------------------------------------------------


def _issued_ticket(client: Client, business: Business, *, departure_offset: datetime.timedelta):
    booking, reservation = booking_with_a_held_seat(client, business)
    with tenant_context(str(client.id)):
        booking.trip.scheduled_departure_at = timezone.now() + departure_offset
        booking.trip.save(update_fields=["scheduled_departure_at"])
    mark_booking_paid(booking=booking)
    with platform_staff_bypass():
        ticket = Ticket.all_objects.get(seat_reservation=reservation)
    return booking, ticket


def test_ticket_reminder_sweep_fires_for_an_issued_ticket_within_the_window() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, ticket = _issued_ticket(client, business, departure_offset=timedelta(hours=1))

    created = sweep_unused_tickets()

    assert created == 1
    with platform_staff_bypass():
        notification = Notification.all_objects.get(
            notification_type=Notification.NotificationType.TICKET_UNUSED_REMINDER,
            related_object_id=ticket.id,
        )
    assert notification.recipient_id == booking.passenger_id


def test_ticket_reminder_sweep_does_not_fire_outside_the_window() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    _issued_ticket(client, business, departure_offset=timedelta(hours=10))

    created = sweep_unused_tickets()

    assert created == 0


def test_ticket_reminder_sweep_does_not_fire_for_a_boarded_ticket() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    _booking, ticket = _issued_ticket(client, business, departure_offset=timedelta(hours=1))
    with platform_staff_bypass():
        Ticket.all_objects.filter(id=ticket.id).update(status=Ticket.Status.BOARDED)

    created = sweep_unused_tickets()

    assert created == 0


def test_ticket_reminder_sweep_fires_only_once_ever_per_ticket() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    _issued_ticket(client, business, departure_offset=timedelta(hours=1))

    first = sweep_unused_tickets()
    second = sweep_unused_tickets()

    assert first == 1
    assert second == 0


# --- notify_kyc_submitted() / notify_kyb_submitted() ------------------------


def test_submitting_a_kyc_document_notifies_every_platform_staff_user() -> None:
    platform_staff_a = _platform_staff_user()
    platform_staff_b = _platform_staff_user()
    client = ClientFactory(name="Acme Shuttle Co")
    staff = ClientStaffUserFactory(client=client)

    with tenant_context(str(client.id)):
        document = submit_kyc_document(
            client=client,
            document_type="certificate_of_incorporation",
            file=SimpleUploadedFile("doc.pdf", b"%PDF-1.4 fake"),
            uploaded_by=staff,
        )

    with platform_staff_bypass():
        notifications = list(
            Notification.all_objects.filter(
                notification_type=Notification.NotificationType.KYC_DOCUMENT_SUBMITTED,
                related_object_id=document.id,
            )
        )
    assert {n.recipient_id for n in notifications} == {platform_staff_a.id, platform_staff_b.id}
    assert all(n.client_id == client.id for n in notifications)


def test_submitting_a_kyb_document_notifies_every_platform_staff_user() -> None:
    platform_staff = _platform_staff_user()
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client, name="Lagos Shuttle Co")
        staff = ClientStaffUserFactory(client=client)
        document = submit_kyb_document(
            business=business,
            document_type="certificate_of_incorporation",
            file=SimpleUploadedFile("doc.pdf", b"%PDF-1.4 fake"),
            uploaded_by=staff,
        )

    with platform_staff_bypass():
        notification = Notification.all_objects.get(
            notification_type=Notification.NotificationType.KYB_DOCUMENT_SUBMITTED,
            related_object_id=document.id,
        )
    assert notification.recipient_id == platform_staff.id
    assert notification.client_id == client.id


def test_notify_kyc_submitted_is_idempotent_same_day() -> None:
    platform_staff = _platform_staff_user()
    client = ClientFactory()
    document_id = client.id  # any real uuid works as a stand-in target id here

    first = notify_kyc_submitted(
        client_id=client.id, client_name=client.name, document_id=document_id
    )
    second = notify_kyc_submitted(
        client_id=client.id, client_name=client.name, document_id=document_id
    )

    assert first == 1
    assert second == 0
    with platform_staff_bypass():
        assert (
            Notification.all_objects.filter(
                recipient=platform_staff, related_object_id=document_id
            ).count()
            == 1
        )


# --- GET /notifications/mine/, POST .../read/, POST .../read-all/ ----------


def test_client_staff_only_sees_their_own_notifications() -> None:
    client = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client)
    staff_b = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        NotificationFactory(client=client, recipient=staff_a)
        NotificationFactory(client=client, recipient=staff_b)

    response = _auth_client(staff_a).get(reverse("notification-mine"))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["count"] == 1


def test_marking_another_users_notification_read_is_a_404_not_a_403() -> None:
    client = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client)
    staff_b = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        other = NotificationFactory(client=client, recipient=staff_b)

    response = _auth_client(staff_a).post(reverse("notification-read", kwargs={"pk": other.id}))

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_marking_a_notification_read_sets_read_at() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        notification = NotificationFactory(client=client, recipient=staff)

    response = _auth_client(staff).post(
        reverse("notification-read", kwargs={"pk": notification.id})
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["read_at"] is not None


def test_read_all_marks_every_unread_notification_for_the_caller() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        NotificationFactory(client=client, recipient=staff)
        NotificationFactory(client=client, recipient=staff)

    response = _auth_client(staff).post(reverse("notification-read-all"))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["marked_read"] == 2


def test_passenger_can_read_their_own_ticket_reminder_notification() -> None:
    """Matches BookingMineView's own passenger-reachable shape (ADR-0003:
    a passenger has no Role)."""
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        NotificationFactory(
            client=client,
            recipient=passenger,
            notification_type=Notification.NotificationType.TICKET_UNUSED_REMINDER,
        )

    response = _auth_client(passenger).get(reverse("notification-mine"))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["count"] == 1


def test_platform_staff_sees_their_own_notifications_spanning_multiple_clients() -> None:
    """The one genuinely new access shape this slice introduces: a
    platform-staff recipient's own notifications are written under
    several different Clients' `client_id` (the submitting Client, not
    the recipient's own — platform staff have none), so `.objects`
    (single-session-client RLS scoping) would silently see nothing."""
    platform_staff = _platform_staff_user()
    client_a = ClientFactory()
    client_b = ClientFactory()
    with platform_staff_bypass():
        NotificationFactory(
            client=client_a,
            recipient=platform_staff,
            notification_type=Notification.NotificationType.KYC_DOCUMENT_SUBMITTED,
        )
        NotificationFactory(
            client=client_b,
            recipient=platform_staff,
            notification_type=Notification.NotificationType.KYB_DOCUMENT_SUBMITTED,
        )

    response = _platform_staff_auth_client(platform_staff).get(reverse("notification-mine"))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["count"] == 2


def test_platform_staff_can_mark_a_cross_client_notification_read() -> None:
    platform_staff = _platform_staff_user()
    client = ClientFactory()
    with platform_staff_bypass():
        notification = NotificationFactory(
            client=client,
            recipient=platform_staff,
            notification_type=Notification.NotificationType.KYC_DOCUMENT_SUBMITTED,
        )

    response = _platform_staff_auth_client(platform_staff).post(
        reverse("notification-read", kwargs={"pk": notification.id})
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["read_at"] is not None
