"""Fat-service layer for Booking creation/cancellation — see
docs/specs/4-fares-seating-booking.md §4.
"""

from decimal import Decimal
from typing import Any, TypedDict

from django.db import IntegrityError, transaction

from apps.core.audit import record_audit_event
from apps.core.idempotency import IdempotencyKeyConflict, hash_request
from apps.core.models import IdempotencyKey
from apps.core.rls import platform_staff_bypass
from apps.fares.services import get_fare
from apps.identity.models import User
from apps.network.models import Stop
from apps.scheduling.models import Trip
from apps.seating.models import Seat, SeatReservation
from apps.seating.services import create_reservation
from apps.ticketing.services import issue_ticket

from .models import Booking

_IDEMPOTENCY_ENDPOINT = "booking.create"


class SeatRequest(TypedDict):
    seat: Seat
    from_stop: Stop
    to_stop: Stop


def _booking_request_hash(*, trip: Trip, passenger: User, seats: list[SeatRequest]) -> str:
    return hash_request(
        {
            "trip": str(trip.id),
            "passenger": str(passenger.id),
            "seats": [
                {
                    "seat": str(seat_request["seat"].id),
                    "from_stop": str(seat_request["from_stop"].id),
                    "to_stop": str(seat_request["to_stop"].id),
                }
                for seat_request in seats
            ],
        }
    )


def _booking_from_idempotency_record(record: IdempotencyKey) -> Booking:
    response_body: dict[str, Any] = record.response_body or {}
    return Booking.objects.get(pk=response_body["booking_id"])


def create_booking(
    *, trip: Trip, passenger: User, seats: list[SeatRequest], idempotency_key: str
) -> Booking:
    """The transaction described in the spec's §3: resolves each seat's
    fare (all-or-nothing — `FareNotConfigured` on any segment aborts
    the whole request before any row is written), creates the `Booking`,
    then one `SeatReservation` per seat via
    `apps.seating.services.create_reservation`, which lets the database's
    exclusion constraint have the final word — a `SeatUnavailable` from
    any one seat rolls back the entire transaction, so a booking is
    never partially held (docs/adr/0004).

    Wraps `apps.core.models.IdempotencyKey` lookup/creation around the
    whole operation. Only a *successful* attempt is memorized: the
    `IdempotencyKey` row is created in the same atomic block as the
    `Booking`/`SeatReservation` rows, so a failed attempt (fare not
    configured, seat conflict) rolls back together with it and leaves
    nothing for a retry with the same key to collide with — a retry
    after a genuine failure is free to try again (e.g. a different
    seat), not permanently locked to the failed outcome. A *matching*
    replay (same key, same request body) after a *successful* attempt
    returns the original `Booking` rather than creating a second one; a
    replay with a different body under the same key raises
    `IdempotencyKeyConflict` (mapped to a 409 by the view layer) — see
    the spec's §6.

    Concurrent duplicate submissions of the same key are handled by
    `IdempotencyKey`'s own `unique_idempotency_key_per_client_endpoint`
    constraint: if two requests race past the initial existence check,
    the second one's final `IdempotencyKey.objects.create()` call raises
    `IntegrityError`, which rolls back that entire attempt (including
    any `Booking`/`SeatReservation` rows it had already written) — the
    same narrow-catch-and-reconcile shape
    `apps.seating.services.create_reservation` already established for
    the exclusion constraint.
    """
    request_hash = _booking_request_hash(trip=trip, passenger=passenger, seats=seats)
    client_id = str(trip.client_id)

    existing = IdempotencyKey.objects.filter(
        client_id=client_id, endpoint=_IDEMPOTENCY_ENDPOINT, key=idempotency_key
    ).first()
    if existing is not None:
        if existing.request_hash != request_hash:
            raise IdempotencyKeyConflict(
                "This Idempotency-Key was already used for a different request."
            )
        return _booking_from_idempotency_record(existing)

    try:
        with transaction.atomic():
            business = trip.business
            # Purchase-time quote — `as_of` defaults to now inside
            # get_fare, so a fare scheduled for next month does not
            # affect what this booking pays.
            quotes = [
                get_fare(
                    trip=trip,
                    from_stop=seat_request["from_stop"],
                    to_stop=seat_request["to_stop"],
                )
                for seat_request in seats
            ]
            total_amount: Decimal = sum((quote.amount for quote in quotes), Decimal("0"))

            booking = Booking.objects.create(
                client=trip.client,
                business=business,
                trip=trip,
                passenger=passenger,
                status=Booking.Status.PENDING_PAYMENT,
                total_amount=total_amount,
                currency=business.currency,
            )
            for seat_request, quote in zip(seats, quotes, strict=True):
                create_reservation(
                    trip=trip,
                    seat=seat_request["seat"],
                    from_stop=seat_request["from_stop"],
                    to_stop=seat_request["to_stop"],
                    booking=booking,
                    hold_minutes=business.seat_hold_minutes,
                    amount=quote.amount,
                    fare_rule=quote.fare_rule,
                    fare_segment_rule=quote.fare_segment_rule,
                )

            IdempotencyKey.objects.create(
                client_id=client_id,
                endpoint=_IDEMPOTENCY_ENDPOINT,
                key=idempotency_key,
                request_hash=request_hash,
                response_status=201,
                response_body={"booking_id": str(booking.id)},
            )
    except IntegrityError:
        record = IdempotencyKey.objects.get(
            client_id=client_id, endpoint=_IDEMPOTENCY_ENDPOINT, key=idempotency_key
        )
        if record.request_hash != request_hash:
            raise IdempotencyKeyConflict(
                "This Idempotency-Key was already used for a different request."
            ) from None
        return _booking_from_idempotency_record(record)

    record_audit_event(
        actor=passenger, action="booking.created", target=booking, total_amount=str(total_amount)
    )
    return booking


def cancel_booking(*, booking: Booking, cancelled_by: User, reason: str) -> Booking:
    """Caller (`apps.booking.serializers.BookingCancelSerializer.validate()`)
    has already checked `booking.status == pending_payment` — same
    pre-validated-input convention as
    `apps.scheduling.services.transition_trip_status`.
    `select_for_update()` guards against a lost-update race with the
    Celery sweep task (`apps.seating.tasks.expire_seat_holds`)
    expiring this same Booking between that validation and this call: if
    the row has already moved on by the time the lock is acquired, this
    returns it unchanged rather than forcing an inconsistent
    cancellation onto an already-`expired` Booking."""
    with transaction.atomic():
        booking = Booking.all_objects.select_for_update().get(pk=booking.pk)
        if booking.status != Booking.Status.PENDING_PAYMENT:
            return booking
        booking.status = Booking.Status.CANCELLED
        booking.cancellation_reason = reason
        booking.save(update_fields=["status", "cancellation_reason"])
        SeatReservation.all_objects.filter(
            booking=booking, status=SeatReservation.Status.HELD
        ).update(status=SeatReservation.Status.RELEASED)
        record_audit_event(
            actor=cancelled_by, action="booking.cancelled", target=booking, reason=reason
        )
    return booking


def mark_booking_paid(*, booking: Booking) -> tuple[Booking, bool]:
    """Called from `apps.payments.services._apply_booking_payment` (the
    Paystack webhook path, which — unlike `cancel_booking` — has no
    authenticated request behind it and therefore no tenancy context
    `TenancyMiddleware` would otherwise have set) and from
    `apps.payments.services.pay_booking_from_wallet` (Phase 7). Unlike
    `cancel_booking`, this must open its own `platform_staff_bypass()`,
    same "a webhook has no ambient tenancy context" reasoning
    `apps.ledger.services` already documents.

    Guard-and-no-op on the wrong status, not an exception. Returns
    `(booking, did_transition)` — **not** just `booking` — so a caller
    can tell "I just paid this" apart from "this was already paid by
    someone else" without both looking identical (`booking.status ==
    PAID` either way). That distinction matters as of Phase 7: with two
    independent ways to reach `PAID` (a Paystack webhook, or
    `pay_booking_from_wallet`'s synchronous path) racing for the same
    booking, `booking.status != PAID` alone can no longer tell a caller
    whether *it* performed the transition — a real gap this return
    value closes, found by this phase's own mandatory concurrency spike
    (`apps/payments/tests/test_wallet_payment_concurrency.py`). The
    pre-Phase-7 caller only ever needed the "expired/cancelled by the
    time payment landed" case (the spec's edge case 6); `did_transition
    is False` now also covers "a different PaymentIntent already paid
    this booking first" the same way, since both are equally "real
    money moved but this payment didn't get to pay for anything" and
    equally worth flagging for manual attention."""
    with platform_staff_bypass(), transaction.atomic():
        booking = Booking.all_objects.select_for_update().get(pk=booking.pk)
        if booking.status != Booking.Status.PENDING_PAYMENT:
            return booking, False
        booking.status = Booking.Status.PAID
        booking.save(update_fields=["status"])
        # Fetched before the bulk .update() below, since .update() does
        # not return individual instances — apps.ticketing.services.issue_ticket
        # needs one call per SeatReservation (docs/specs/6-ticketing.md:
        # a Booking may hold several seats, and each needs its own
        # independently scannable Ticket).
        held_reservations = list(
            SeatReservation.all_objects.filter(booking=booking, status=SeatReservation.Status.HELD)
        )
        SeatReservation.all_objects.filter(
            booking=booking, status=SeatReservation.Status.HELD
        ).update(status=SeatReservation.Status.CONFIRMED)
        for reservation in held_reservations:
            issue_ticket(booking=booking, seat_reservation=reservation)
        record_audit_event(
            actor=None, action="booking.paid", target=booking, client_id=str(booking.client_id)
        )
    return booking, True
