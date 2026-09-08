"""Fat-service layer for Booking creation/cancellation — see
docs/specs/4-fares-seating-booking.md §4.
"""

import secrets
from decimal import Decimal
from typing import Any, TypedDict

from django.db import IntegrityError, transaction

from apps.businesses.models import Business
from apps.core.audit import record_audit_event
from apps.core.idempotency import IdempotencyKeyConflict, hash_request
from apps.core.models import IdempotencyKey
from apps.core.rls import platform_staff_bypass
from apps.fares.services import get_fare
from apps.identity.models import User
from apps.network.models import Stop
from apps.scheduling.models import Trip
from apps.seating.models import Seat, SeatReservation
from apps.seating.services import create_reservation, get_availability, segment_sequence_range
from apps.ticketing.capacity import TripNotConfigured, TripSoldOut, check_capacity
from apps.ticketing.models import Ticket
from apps.ticketing.services import issue_open_seating_tickets, issue_ticket

from .models import Booking

_IDEMPOTENCY_ENDPOINT = "booking.create"

# docs/specs/18-manifest-and-staff-booking.md slice 1. Deliberately the
# same alphabet, length and retry count as `apps.incidents.services` —
# two references a human reads aloud should not have two different
# shapes, and Crockford base32 is what that one already chose (no
# I/L/O/U, so nothing is ambiguous over a phone).
_REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_REFERENCE_LENGTH = 6
_REFERENCE_ATTEMPTS = 5
_REFERENCE_CONSTRAINT = "unique_booking_reference_per_business"


class SeatRequest(TypedDict):
    seat: Seat
    from_stop: Stop
    to_stop: Stop


def _generate_reference() -> str:
    body = "".join(secrets.choice(_REFERENCE_ALPHABET) for _ in range(_REFERENCE_LENGTH))
    return f"BKG-{body}"


def _create_booking_row(**fields: Any) -> Booking:
    """Create a `Booking`, retrying on a reference collision.

    Each attempt gets its own nested `transaction.atomic()`. That is
    load-bearing twice over here, not once:

    1. An `IntegrityError` poisons the surrounding transaction, so a
       retry without a savepoint would fail on the very next statement
       with `TransactionManagementError` rather than succeeding — the
       reason `apps.incidents.services._create_with_reference` has one.
    2. `create_booking` runs this **inside** its own
       `transaction.atomic()`, whose `except IntegrityError` handler
       exists to reconcile an idempotency-key race. Without the
       savepoint a reference collision would escape into that handler
       and be reported as a duplicate submission, which it is not.

    Only a collision on this specific constraint is retried; anything
    else propagates immediately rather than being tried five times and
    then reported as if it had been a collision.
    """
    for attempt in range(_REFERENCE_ATTEMPTS):
        try:
            with transaction.atomic():
                return Booking.objects.create(reference=_generate_reference(), **fields)
        except IntegrityError as exc:
            if _REFERENCE_CONSTRAINT not in str(exc) or attempt == _REFERENCE_ATTEMPTS - 1:
                raise
    raise AssertionError("unreachable: the final attempt either returns or raises")


def _booking_request_hash(
    *,
    trip: Trip,
    passenger: User,
    seats: list[SeatRequest],
    passenger_count: int | None = None,
    from_stop: Stop | None = None,
    to_stop: Stop | None = None,
) -> str:
    """Covers the open-seating fields too, so a replay under one
    Idempotency-Key with a *different* passenger count is caught as a
    conflict rather than quietly returning the first booking."""
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
            "passenger_count": passenger_count,
            "from_stop": None if from_stop is None else str(from_stop.id),
            "to_stop": None if to_stop is None else str(to_stop.id),
        }
    )


def _booking_from_idempotency_record(record: IdempotencyKey) -> Booking:
    response_body: dict[str, Any] = record.response_body or {}
    return Booking.objects.get(pk=response_body["booking_id"])


def is_quick_book(trip: Trip) -> bool:
    """Reservation mode with seat *choice* turned off — the operator
    assigns seats, the passenger only says how many
    (`Business.seat_selection_enabled`, docs/specs/10-booking-modes.md).

    Read live off the Business rather than snapshotted onto the Trip
    like `booking_mode` and `fare_collection_mode` are. Those two are
    snapshotted because they describe *what was sold*, and changing
    them under an existing booking would rewrite its terms. This one
    describes only how the seat gets picked; a booking made either way
    ends up holding the same named seats, so an operator who flips it
    mid-week does not invalidate anything already sold.
    """
    return (
        trip.booking_mode != Business.BookingMode.OPEN_SEATING
        and not trip.business.seat_selection_enabled
    )


def _allocate_seats(
    *, trip: Trip, from_stop: Stop, to_stop: Stop, passenger_count: int
) -> list[SeatRequest]:
    """Picks `passenger_count` free seats for a quick-book request.

    All-or-nothing (the spec's own edge case): fewer free seats than
    passengers is refused outright rather than partially allocated, so a
    group is never split across a booking that half-succeeded.

    Ordering is explicit rather than inherited from `Seat.Meta.ordering`,
    which is `-created_at` — allocating the most recently *added* seat
    first would scatter a group around the vehicle and hand out the odd
    seat a later seat-map edit appended. Row/column order seats a group
    together, and falls back to seat number for vehicle types with no
    geometry (both are valid layouts — see `seat-picker`'s own note).

    Unlike open seating, this path has a real database constraint behind
    it: two concurrent quick books that pick the same seat collide on
    the GiST exclusion constraint in `create_reservation` and one rolls
    back whole (docs/adr/0004). No lock is needed here.
    """
    availability = get_availability(trip=trip, from_stop=from_stop, to_stop=to_stop)
    if not availability:
        raise TripNotConfigured("Seating is not yet configured for this trip.")
    free = [entry["seat"] for entry in availability if entry["is_available"]]
    free.sort(
        key=lambda seat: (seat.row is None, seat.row or 0, seat.column or 0, seat.seat_number)
    )
    if len(free) < passenger_count:
        raise TripSoldOut("There are not enough seats left on this departure.")
    return [
        {"seat": seat, "from_stop": from_stop, "to_stop": to_stop}
        for seat in free[:passenger_count]
    ]


def create_booking(
    *,
    trip: Trip,
    passenger: User,
    seats: list[SeatRequest] | None = None,
    passenger_count: int | None = None,
    from_stop: Stop | None = None,
    to_stop: Stop | None = None,
    idempotency_key: str,
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
    open_seating = trip.booking_mode == Business.BookingMode.OPEN_SEATING
    seats = seats or []
    request_hash = _booking_request_hash(
        trip=trip,
        passenger=passenger,
        seats=seats,
        passenger_count=passenger_count,
        from_stop=from_stop,
        to_stop=to_stop,
    )
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

            if open_seating:
                assert passenger_count is not None
                assert from_stop is not None and to_stop is not None
                # The Trip row lock, per docs/adr/0008. It cannot
                # prevent an oversell on its own — see
                # apps.ticketing.capacity's module docstring for exactly
                # what it does and does not guarantee — but it makes the
                # count below consistent between concurrent bookings.
                Trip.objects.select_for_update().get(pk=trip.pk)
                from_sequence, to_sequence = segment_sequence_range(
                    route_id=trip.route_id, from_stop=from_stop, to_stop=to_stop
                )
                check_capacity(
                    trip=trip,
                    from_sequence=from_sequence,
                    to_sequence=to_sequence,
                    places=passenger_count,
                )
                unit_fare = get_fare(trip=trip, from_stop=from_stop, to_stop=to_stop)
                booking = _create_booking_row(
                    client=trip.client,
                    business=business,
                    trip=trip,
                    passenger=passenger,
                    status=Booking.Status.PENDING_PAYMENT,
                    total_amount=unit_fare.amount * passenger_count,
                    currency=business.currency,
                    passenger_count=passenger_count,
                    from_stop=from_stop,
                    to_stop=to_stop,
                )
                total_amount: Decimal = booking.total_amount
                IdempotencyKey.objects.create(
                    client_id=client_id,
                    endpoint=_IDEMPOTENCY_ENDPOINT,
                    key=idempotency_key,
                    request_hash=request_hash,
                    response_status=201,
                    response_body={"booking_id": str(booking.id)},
                )
                record_audit_event(
                    actor=passenger,
                    action="booking.created",
                    target=booking,
                    total_amount=str(total_amount),
                )
                return booking

            if is_quick_book(trip):
                assert passenger_count is not None
                assert from_stop is not None and to_stop is not None
                # Allocated here, inside the transaction, rather than by
                # the caller: the seats a request is given must be free
                # at the moment they are reserved, not at the moment the
                # body was validated.
                seats = _allocate_seats(
                    trip=trip,
                    from_stop=from_stop,
                    to_stop=to_stop,
                    passenger_count=passenger_count,
                )

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
            total_amount = sum((quote.amount for quote in quotes), Decimal("0"))

            booking = _create_booking_row(
                client=trip.client,
                business=business,
                trip=trip,
                passenger=passenger,
                status=Booking.Status.PENDING_PAYMENT,
                total_amount=total_amount,
                currency=business.currency,
                # One place per seat — the number of passengers on a
                # reservation booking *is* the number of seats, which is
                # why the API refuses a body carrying both.
                passenger_count=len(seats),
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

        trip = Trip.all_objects.select_related("route", "business", "vehicle__vehicle_type").get(
            pk=booking.trip_id
        )
        if trip.booking_mode == Business.BookingMode.OPEN_SEATING:
            # The same Trip row lock create_booking takes, for the same
            # reason: it makes the capacity count consistent between
            # concurrent issuances. It does not refuse — the money is
            # already taken. See apps.ticketing.capacity.
            Trip.all_objects.select_for_update().get(pk=trip.pk)
            # Guard against double issuance: mark_booking_paid already
            # no-ops on a non-pending booking, but the two paths that
            # can reach PAID (webhook, wallet) make belt-and-braces
            # cheap here, and duplicate tickets would each count against
            # capacity.
            if not Ticket.all_objects.filter(booking=booking).exists():
                booking_from_stop = booking.from_stop
                booking_to_stop = booking.to_stop
                assert booking_from_stop is not None
                assert booking_to_stop is not None
                issue_open_seating_tickets(
                    booking=booking,
                    from_stop=booking_from_stop,
                    to_stop=booking_to_stop,
                    passenger_count=booking.passenger_count,
                )
        else:
            # Fetched before the bulk .update() below, since .update() does
            # not return individual instances — apps.ticketing.services.issue_ticket
            # needs one call per SeatReservation (docs/specs/6-ticketing.md:
            # a Booking may hold several seats, and each needs its own
            # independently scannable Ticket).
            held_reservations = list(
                SeatReservation.all_objects.filter(
                    booking=booking, status=SeatReservation.Status.HELD
                )
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


def mark_booking_completed_if_fully_boarded(*, booking: Booking) -> tuple[Booking, bool]:
    """Called from `apps.ticketing.services.validate_ticket` right after
    it boards a Ticket — via a function-local import there, not a
    module-level one, since this module already imports
    `apps.ticketing.services` at the top (for `issue_ticket`) and a
    module-level import in the other direction would be circular.

    Ticket-boarding-driven, not `Trip.status`-driven: a Trip only
    reaches `COMPLETED` via a manual staff/driver action with no sweep
    behind it (see `apps.scheduling.services.transition_trip_status`),
    so tying this to it would mean a booking might never complete even
    after its passenger genuinely boarded and rode. Boarding every
    Ticket on a Booking is the one signal that's both automatic and
    specific to this passenger.

    Same guard-and-no-op, `platform_staff_bypass()` +
    `select_for_update()` shape as `mark_booking_paid`, above, and the
    same `(booking, did_transition)` return reasoning: two different
    validator devices can race to board the last two seats on the same
    multi-seat booking, so a caller needs to tell "I just completed
    this booking" apart from "someone else's concurrent scan already
    did" — proven, not assumed, by this slice's own concurrency test."""
    with platform_staff_bypass(), transaction.atomic():
        booking = Booking.all_objects.select_for_update().get(pk=booking.pk)
        if booking.status != Booking.Status.PAID:
            return booking, False
        tickets = Ticket.all_objects.filter(booking=booking)
        # The `.exists()` check on the unfiltered queryset matters: an
        # empty queryset's `.exclude(...).exists()` is trivially False,
        # which would otherwise silently "complete" a ticket-less
        # booking (shouldn't happen for a paid booking, but this isn't
        # the place to assume that).
        if not tickets.exists() or tickets.exclude(status=Ticket.Status.BOARDED).exists():
            return booking, False
        booking.status = Booking.Status.COMPLETED
        booking.save(update_fields=["status"])
        record_audit_event(
            actor=None,
            action="booking.completed",
            target=booking,
            client_id=str(booking.client_id),
        )
    return booking, True
