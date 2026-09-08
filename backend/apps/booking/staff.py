"""Booking on a passenger's behalf — docs/specs/18-manifest-and-staff-booking.md
slice 2.

## Why this is its own module

`apps.payments.services` imports `apps.booking.services` (for
`mark_booking_paid`), so `apps.booking.services` cannot import the
wallet payment service back without a circular import. This module sits
beside it in the same app and imports downhill in one direction only —
the same separation `apps.booking.manifest` already uses for slice 1,
and a plainer answer than a function-level import apologising for the
layering.

## Why it calls `create_booking` rather than writing its own path

The open-seating capacity invariant is enforced by an application-level
`Trip` row lock with **no database constraint behind it** (ADR-0008). A
second write path that forgot to take that lock would silently oversell
a departure, and nothing in the schema would catch it. So this composes
the existing service and adds only what is genuinely new: who acted, and
an optional wallet settlement.
"""

from typing import Any, TypedDict

from apps.core.audit import record_audit_event
from apps.identity.models import User
from apps.network.models import Stop
from apps.payments.models import PaymentIntent
from apps.payments.services import (
    BookingNotPayable,
    InsufficientWalletBalance,
    pay_booking_from_wallet,
)
from apps.scheduling.models import Trip

from .models import Booking
from .services import SeatRequest, create_booking

#: Named for `SPECTACULAR_SETTINGS["ENUM_NAME_OVERRIDES"]`. An unnamed
#: enum generates a type whose name is a hash of its choice set, which
#: renames itself the moment the set grows — spec 16's recorded trap.
STAFF_BOOKING_PAYMENT_STATUS_CHOICES = [
    ("not_attempted", "Not attempted"),
    ("succeeded", "Succeeded"),
    ("failed", "Failed"),
]

NOT_ATTEMPTED = "not_attempted"
SUCCEEDED = "succeeded"
FAILED = "failed"


class PaymentOutcome(TypedDict):
    """What happened to the money, stated separately from the booking.

    Three states, not two. "Failed" and "never tried" are different
    facts, and a counter agent who left the wallet box unticked must not
    read a failure notice.
    """

    status: str
    reason: str
    payment_intent: str | None


def _settle_from_wallet(*, booking: Booking, passenger: User) -> PaymentOutcome:
    """Wallet settlement, reporting rather than raising.

    **A failure here never rolls the booking back.** The seats are
    genuinely held, the passenger can top up and pay from their own app,
    and destroying a valid hold because the balance came up short would
    be a worse outcome than saying so — the spec's own instruction, and
    the reason this returns a value instead of propagating.
    """
    if booking.status != Booking.Status.PENDING_PAYMENT:
        # Reached by an idempotent replay: `create_booking` returned the
        # original booking, which the first attempt already paid for.
        # Calling the payment service again would raise
        # `BookingNotPayable` and report a failure for a booking that is
        # in fact paid — the retry would look worse than the original.
        return {
            "status": SUCCEEDED,
            "reason": "This booking was already paid for.",
            "payment_intent": None,
        }
    try:
        intent: PaymentIntent = pay_booking_from_wallet(booking=booking, passenger=passenger)
    except InsufficientWalletBalance:
        return {
            "status": FAILED,
            "reason": "The passenger's wallet balance is not enough to pay for this booking. "
            "The seats are held — they can top up and pay from their own app.",
            "payment_intent": None,
        }
    except BookingNotPayable as exc:
        return {"status": FAILED, "reason": str(exc), "payment_intent": None}
    return {"status": SUCCEEDED, "reason": "", "payment_intent": str(intent.id)}


def create_staff_booking(
    *,
    trip: Trip,
    passenger: User,
    booked_by: User,
    seats: list[SeatRequest] | None = None,
    passenger_count: int | None = None,
    from_stop: Stop | None = None,
    to_stop: Stop | None = None,
    pay_from_wallet: bool = False,
    idempotency_key: str,
) -> tuple[Booking, PaymentOutcome]:
    """Create a booking for `passenger`, on `booked_by`'s authority.

    Every failure mode of ordinary booking — fare not configured, seat
    taken, trip sold out, idempotency conflict — comes straight out of
    `create_booking` unchanged, and is mapped to a response by the view
    exactly as the passenger-facing endpoint maps it. Nothing about
    seat allocation, fare quoting or the capacity lock is re-implemented
    here.

    The audit entry is written on **every** call, including an
    idempotent replay that created nothing: what it records is that this
    staff user asked to book for this passenger, and a retry is such an
    ask. `idempotency_key` travels in the metadata so a duplicate row is
    identifiable as one rather than mistaken for two separate acts.
    """
    booking = create_booking(
        trip=trip,
        passenger=passenger,
        seats=seats,
        passenger_count=passenger_count,
        from_stop=from_stop,
        to_stop=to_stop,
        idempotency_key=idempotency_key,
    )

    payment: PaymentOutcome = {
        "status": NOT_ATTEMPTED,
        "reason": "",
        "payment_intent": None,
    }
    if pay_from_wallet:
        payment = _settle_from_wallet(booking=booking, passenger=passenger)
        if payment["status"] == SUCCEEDED:
            # `pay_booking_from_wallet` transitions a **re-fetched,
            # locked** copy of the row, so this in-memory instance still
            # reads `pending_payment`. Without this refresh the response
            # would report a successful payment beside an unpaid
            # booking — caught by this slice's own test, and exactly the
            # sort of disagreement a counter agent would have to
            # resolve by refreshing the page and hoping.
            booking.refresh_from_db()

    # Written after settlement so the trail records what actually
    # happened to the money, not what was intended. A dispute about a
    # booking someone says they did not make is otherwise unanswerable —
    # and `pay_booking_from_wallet` records its own event with
    # `actor=passenger`, which is right for the passenger-initiated path
    # and would be actively misleading as the only record of this one.
    metadata: dict[str, Any] = {
        "passenger": str(passenger.id),
        "trip": str(trip.id),
        "idempotency_key": idempotency_key,
        "payment_status": payment["status"],
    }
    record_audit_event(
        actor=booked_by,
        action="booking.staff_created",
        target=booking,
        client_id=str(booking.client_id),
        **metadata,
    )
    return booking, payment
