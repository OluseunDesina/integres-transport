"""Fat-service layer for apps.ticketing — see docs/specs/6-ticketing.md.

`validate_ticket` mirrors `apps.tapngo.services.record_tap`'s exact
shape: idempotency-key lookup first (a replay of an already-failed
attempt re-fails the same way, not treated as fresh), then typed
validation exceptions raised distinctly so the view layer maps each to
its own HTTP status, never a generic one.
"""

from datetime import timedelta
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.booking.models import Booking
from apps.core.audit import record_audit_event
from apps.core.idempotency import IdempotencyKeyConflict, hash_request
from apps.core.models import IdempotencyKey
from apps.identity.models import User
from apps.scheduling.models import Trip
from apps.seating.models import SeatReservation

from . import signing
from .models import Ticket

_VALIDATE_IDEMPOTENCY_ENDPOINT = "ticketing.validate"


class InvalidSignature(Exception):
    """The payload failed CBOR/Ed25519 verification — wraps any
    `signing.TicketSigningError` (bad base64, bad CBOR, unknown `kid`,
    or a bad signature; a verifier never distinguishes between these).
    Mapped to 400."""


class TicketNotYetValid(Exception):
    """Scanned before `trip.scheduled_departure_at -
    TICKET_VALID_BEFORE_MINUTES`. Mapped to 400."""


class TicketExpired(Exception):
    """Scanned after `Ticket.expires_at`. Mapped to 409."""


class TicketRevoked(Exception):
    """`Ticket.status == REVOKED`. Mapped to 409."""


class WrongTrip(Exception):
    """The payload's `trip_id` doesn't match the URL's `{id}`. Mapped
    to 400."""


class UnknownTicket(Exception):
    """The signature verifies but no `Ticket` row matches the payload's
    `seat_reservation_id` — defensive; shouldn't happen for a payload
    this backend itself signed, but the payload is untrusted input
    until verification succeeds. Mapped to 404."""


class AlreadyBoarded(Exception):
    """A *different* Idempotency-Key hit an already-`boarded` Ticket —
    a genuine double-scan, not a retry (a *matching* replay is handled
    by the idempotency-key lookup itself, before this is ever raised).
    Mapped to 409."""


def issue_ticket(*, booking: Booking, seat_reservation: SeatReservation) -> Ticket:
    """Creates the one `Ticket` for a just-confirmed `SeatReservation`.
    Called only from `apps.booking.services.mark_booking_paid`, already
    inside its `platform_staff_bypass()`/`transaction.atomic()` block —
    no separate RLS bypass is needed here (nested `platform_staff_bypass()`
    calls are re-entrant no-ops per `apps.core.rls`'s own depth counter).

    `expires_at` is anchored to the trip's own schedule, not to issuance
    time, so a passenger who pays days before travel still gets a QR
    that's only checkable near the trip (see docs/specs/6-ticketing.md's
    Data model section). The valid-*from* bound
    (`TICKET_VALID_BEFORE_MINUTES`) isn't stored on the row — it's
    recomputed from `trip.scheduled_departure_at` wherever needed
    (`validate_ticket`, below), same as this function already does for
    `expires_at`.
    """
    trip = booking.trip
    issued_at = timezone.now()
    valid_after = timedelta(minutes=settings.TICKET_VALID_AFTER_MINUTES)
    expires_at = trip.scheduled_departure_at + valid_after

    signed_payload = signing.sign_ticket(
        booking_id=str(booking.id),
        seat_reservation_id=str(seat_reservation.id),
        trip_id=str(trip.id),
        seat_id=str(seat_reservation.seat_id),
        from_stop_id=str(seat_reservation.from_stop_id),
        to_stop_id=str(seat_reservation.to_stop_id),
        issued_at=issued_at,
        expires_at=expires_at,
    )

    ticket = Ticket.objects.create(
        client=booking.client,
        booking=booking,
        seat_reservation=seat_reservation,
        trip=trip,
        kid=settings.TICKET_SIGNING_ACTIVE_KID,
        signed_payload=signed_payload,
        issued_at=issued_at,
        expires_at=expires_at,
    )
    record_audit_event(
        actor=None, action="ticket.issued", target=ticket, client_id=str(booking.client_id)
    )
    return ticket


def _validate_request_hash(*, trip: Trip, payload: str) -> str:
    return hash_request({"trip": str(trip.id), "payload": payload})


def _ticket_from_idempotency_record(record: IdempotencyKey) -> Ticket:
    response_body: dict[str, Any] = record.response_body or {}
    return Ticket.objects.get(pk=response_body["ticket_id"])


def validate_ticket(
    *, trip: Trip, payload: str, validated_by: User, idempotency_key: str
) -> Ticket:
    """The validator action (`POST /trips/{id}/tickets/validate/`).
    Idempotency follows `apps.tapngo.services.record_tap`'s exact
    shape: the idempotency-key lookup happens first (a replay of an
    already-failed attempt re-fails the same way, not treated as a
    fresh attempt against possibly-changed state), then signature
    verification, then trip-match/time-window/status checks — each of
    which raises its own typed exception rather than a generic one, so
    the view layer can map each to the exact status code
    docs/specs/6-ticketing.md's edge cases enumerate.
    """
    request_hash = _validate_request_hash(trip=trip, payload=payload)
    client_id = str(trip.client_id)

    existing = IdempotencyKey.objects.filter(
        client_id=client_id, endpoint=_VALIDATE_IDEMPOTENCY_ENDPOINT, key=idempotency_key
    ).first()
    if existing is not None:
        if existing.request_hash != request_hash:
            raise IdempotencyKeyConflict(
                "This Idempotency-Key was already used for a different request."
            )
        return _ticket_from_idempotency_record(existing)

    try:
        claims = signing.verify_and_decode(payload=payload)
    except signing.TicketSigningError as exc:
        raise InvalidSignature(str(exc)) from exc

    if claims["trip_id"] != str(trip.id):
        raise WrongTrip("This ticket was not issued for this trip.")

    try:
        with transaction.atomic():
            ticket = Ticket.objects.select_for_update().get(
                seat_reservation_id=UUID(claims["seat_reservation_id"])
            )

            now = timezone.now()
            valid_from = trip.scheduled_departure_at - timedelta(
                minutes=settings.TICKET_VALID_BEFORE_MINUTES
            )
            if now < valid_from:
                raise TicketNotYetValid("This ticket is not valid yet.")
            if now > ticket.expires_at:
                raise TicketExpired("This ticket has expired.")
            if ticket.status == Ticket.Status.REVOKED:
                raise TicketRevoked("This ticket has been revoked.")
            if ticket.status == Ticket.Status.BOARDED:
                # Not necessarily a genuine second scan: a concurrent
                # request under the *same* key can race past the
                # initial idempotency-key lookup above (before either
                # request has written its IdempotencyKey row yet), then
                # block on select_for_update() until the first request
                # commits — by the time this one acquires the lock, the
                # Ticket already reads as boarded. Re-check for a
                # matching IdempotencyKey record, now that the row lock
                # makes that check race-free, before concluding this is
                # a real conflict.
                matching = IdempotencyKey.objects.filter(
                    client_id=client_id,
                    endpoint=_VALIDATE_IDEMPOTENCY_ENDPOINT,
                    key=idempotency_key,
                    request_hash=request_hash,
                ).first()
                if matching is not None:
                    return _ticket_from_idempotency_record(matching)
                raise AlreadyBoarded("This ticket has already been boarded.")

            ticket.status = Ticket.Status.BOARDED
            ticket.boarded_at = now
            ticket.save(update_fields=["status", "boarded_at"])

            IdempotencyKey.objects.create(
                client_id=client_id,
                endpoint=_VALIDATE_IDEMPOTENCY_ENDPOINT,
                key=idempotency_key,
                request_hash=request_hash,
                response_status=200,
                response_body={"ticket_id": str(ticket.id)},
            )
    except Ticket.DoesNotExist as exc:
        raise UnknownTicket("No ticket matches this payload.") from exc
    except IntegrityError:
        # Reachable only for the IdempotencyKey race itself — mirrors
        # apps.tapngo.services.record_tap's own identical reconciliation
        # around its own IdempotencyKey.objects.create() call.
        record = IdempotencyKey.objects.get(
            client_id=client_id, endpoint=_VALIDATE_IDEMPOTENCY_ENDPOINT, key=idempotency_key
        )
        if record.request_hash != request_hash:
            raise IdempotencyKeyConflict(
                "This Idempotency-Key was already used for a different request."
            ) from None
        return _ticket_from_idempotency_record(record)

    record_audit_event(
        actor=validated_by, action="ticket.boarded", target=ticket, client_id=client_id
    )
    return ticket
