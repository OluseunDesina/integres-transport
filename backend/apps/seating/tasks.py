"""Celery Beat sweep job — see docs/specs/4-fares-seating-booking.md
§4. Runs every minute (registered via a data migration seeding a
django_celery_beat IntervalSchedule + PeriodicTask), materially more
frequent than apps.scheduling's daily Trip-generation job since a
default 15-minute hold needs sub-hold-duration granularity to expire
promptly. Expires stale `held` SeatReservation rows and, for any
Booking whose reservations are now all non-held, transitions that
Booking to `expired` in the same pass — never left dangling in
`pending_payment` against seats nobody holds any more.
"""

from celery import shared_task
from django.db import transaction
from django.utils import timezone

from apps.booking.models import Booking
from apps.core.audit import record_audit_event
from apps.core.rls import platform_staff_bypass

from .models import SeatReservation


@shared_task
def expire_seat_holds() -> None:
    # A Celery task has no ambient tenancy context or open transaction —
    # per CLAUDE.md, any code touching BaseModel rows outside a request
    # must call apps.core.rls.set_rls_session_vars (here, via
    # platform_staff_bypass) itself, inside an open transaction, or every
    # query/write is silently empty/rejected under RLS. all_objects, not
    # .objects, throughout — same reasoning as generate_trips.
    with platform_staff_bypass():
        with transaction.atomic():
            expired_reservations = list(
                SeatReservation.all_objects.select_for_update().filter(
                    status=SeatReservation.Status.HELD, held_until__lt=timezone.now()
                )
            )
            reservation_ids = [reservation.id for reservation in expired_reservations]
            booking_ids = {reservation.booking_id for reservation in expired_reservations}
            SeatReservation.all_objects.filter(id__in=reservation_ids).update(
                status=SeatReservation.Status.EXPIRED
            )

            expired_booking_count = 0
            for booking_id in booking_ids:
                still_held = SeatReservation.all_objects.filter(
                    booking_id=booking_id, status=SeatReservation.Status.HELD
                ).exists()
                if still_held:
                    continue
                expired_booking_count += Booking.all_objects.filter(
                    id=booking_id, status=Booking.Status.PENDING_PAYMENT
                ).update(status=Booking.Status.EXPIRED)

        record_audit_event(
            actor=None,
            action="seating.holds_expired",
            client_id=None,
            reservation_count=len(reservation_ids),
            booking_count=expired_booking_count,
        )
