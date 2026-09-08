"""Fat-service layer for apps.ticketing — see docs/specs/6-ticketing.md
and docs/specs/10-booking-modes.md.

`validate_ticket` mirrors `apps.tapngo.services.record_tap`'s exact
shape: idempotency-key lookup first (a replay of an already-failed
attempt re-fails the same way, not treated as fresh), then typed
validation exceptions raised distinctly so the view layer maps each to
its own HTTP status, never a generic one.

`validate_credential` is the same action reached by different fare
media: a passenger presenting a `TapCredential` on a *prepaid* trip,
which resolves to the `Ticket` they already hold instead of opening a
pay-as-you-go journey (docs/specs/10-booking-modes.md — the credential
became universal, the pay-after fare model did not). The two differ
**only** in how the Ticket is found; everything from the row lock
onwards is one shared body, deliberately, so the boarding rules cannot
drift apart between them.
"""

from collections.abc import Callable
from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone
from psycopg.types.range import Range

from apps.booking.models import Booking
from apps.businesses.models import Business
from apps.core.audit import record_audit_event
from apps.core.idempotency import IdempotencyKeyConflict, hash_request
from apps.core.models import IdempotencyKey
from apps.identity.models import User
from apps.network.models import Stop
from apps.scheduling.models import Trip
from apps.seating.models import SeatReservation
from apps.seating.services import segment_sequence_range
from apps.tapngo.services import CredentialInactive, resolve_credential

from . import capacity, signing
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


class TripNotPrepaid(Exception):
    """A tap credential was presented on a pay-as-you-go trip, which
    sells no tickets to board. Mapped to 400.

    Distinct from `NoTicketForCredential` on purpose: "there is no
    ticket here" is true but useless to a conductor, who needs to be
    told to record a board tap instead. The mirror image of
    `apps.tapngo.services.TripNotPayAsYouGo`."""


class NoTicketForCredential(Exception):
    """A valid, active credential resolved to a passenger holding no
    Ticket on this trip. Mapped to 404 — and, per
    docs/specs/10-booking-modes.md's own edge case, *never* to a
    silently-opened `FareJourney`, which would charge a passenger on a
    service they already paid for up front."""


def _issue(
    *,
    booking: Booking,
    from_stop: Stop,
    to_stop: Stop,
    seat_reservation: SeatReservation | None,
    passenger_index: int | None,
    segment_range: Range,
) -> Ticket:
    """The single `Ticket` write path, shared by both booking modes.

    `expires_at` is anchored to the trip's own schedule, not to issuance
    time, so a passenger who pays days before travel still gets a QR
    that's only checkable near the trip (see docs/specs/6-ticketing.md's
    Data model section). The valid-*from* bound
    (`TICKET_VALID_BEFORE_MINUTES`) isn't stored on the row — it's
    recomputed from `trip.scheduled_departure_at` wherever needed
    (`validate_ticket`, below), same as this function already does for
    `expires_at`.

    The id is generated **here, before signing**, rather than left to
    the insert: `signed_payload` is a column on the row being written
    and ADR-0005's payload carries `ticket_id`, so the value has to
    exist first. Safe because `BaseModel.id` is `default=uuid.uuid4`,
    not database-assigned.
    """
    trip = booking.trip
    issued_at = timezone.now()
    valid_after = timedelta(minutes=settings.TICKET_VALID_AFTER_MINUTES)
    expires_at = trip.scheduled_departure_at + valid_after

    ticket_id = uuid4()
    signed_payload = signing.sign_ticket(
        ticket_id=str(ticket_id),
        booking_id=str(booking.id),
        seat_reservation_id=None if seat_reservation is None else str(seat_reservation.id),
        trip_id=str(trip.id),
        seat_id=None if seat_reservation is None else str(seat_reservation.seat_id),
        from_stop_id=str(from_stop.id),
        to_stop_id=str(to_stop.id),
        issued_at=issued_at,
        expires_at=expires_at,
    )

    ticket = Ticket.objects.create(
        id=ticket_id,
        client=booking.client,
        booking=booking,
        seat_reservation=seat_reservation,
        passenger_index=passenger_index,
        trip=trip,
        from_stop=from_stop,
        to_stop=to_stop,
        segment_range=segment_range,
        kid=settings.TICKET_SIGNING_ACTIVE_KID,
        signed_payload=signed_payload,
        issued_at=issued_at,
        expires_at=expires_at,
    )
    record_audit_event(
        actor=None, action="ticket.issued", target=ticket, client_id=str(booking.client_id)
    )
    return ticket


def issue_ticket(*, booking: Booking, seat_reservation: SeatReservation) -> Ticket:
    """Creates the one `Ticket` for a just-confirmed `SeatReservation`
    (reservation mode). Called only from
    `apps.booking.services.mark_booking_paid`, already inside its
    `platform_staff_bypass()`/`transaction.atomic()` block — no separate
    RLS bypass is needed here (nested `platform_staff_bypass()` calls
    are re-entrant no-ops per `apps.core.rls`'s own depth counter).
    """
    # The reservation already holds the derived range — reuse it rather
    # than recomputing. Cheaper, and it makes drift between a ticket and
    # the reservation that produced it impossible by construction.
    return _issue(
        booking=booking,
        from_stop=seat_reservation.from_stop,
        to_stop=seat_reservation.to_stop,
        seat_reservation=seat_reservation,
        passenger_index=None,
        segment_range=seat_reservation.segment_range,
    )


def issue_open_seating_tickets(
    *, booking: Booking, from_stop: Stop, to_stop: Stop, passenger_count: int
) -> list[Ticket]:
    """Issues one seatless `Ticket` per passenger on an open-seating
    booking, numbered 0..n-1, and records an oversell if the departure
    has one.

    **This is the only sanctioned way to create open-seating tickets**
    (docs/adr/0008's first standing obligation): the invariant has no
    database constraint behind it, so a path that writes `Ticket` rows
    directly would silently defeat it with nothing to catch the mistake.

    Deliberately does **not** refuse when over capacity. It runs from
    `mark_booking_paid`, i.e. from the Paystack webhook with the money
    already taken; a paid passenger holding no ticket is worse than an
    oversold bus. See `apps.ticketing.capacity` for the full reasoning
    and for what the `Trip` row lock does and does not guarantee.
    """
    trip = booking.trip
    # tenant_scoped=False: this runs from mark_booking_paid, inside
    # platform_staff_bypass(), where `.objects` sees nothing.
    from_sequence, to_sequence = segment_sequence_range(
        route_id=trip.route_id, from_stop=from_stop, to_stop=to_stop, tenant_scoped=False
    )
    segment_range = Range(from_sequence, to_sequence)
    tickets = [
        _issue(
            booking=booking,
            from_stop=from_stop,
            to_stop=to_stop,
            seat_reservation=None,
            passenger_index=index,
            segment_range=segment_range,
        )
        for index in range(passenger_count)
    ]

    capacity.record_oversell_if_any(
        trip=trip,
        from_stop=from_stop,
        to_stop=to_stop,
        from_sequence=from_sequence,
        to_sequence=to_sequence,
    )
    return tickets


def _validate_request_hash(*, trip: Trip, payload: str) -> str:
    return hash_request({"trip": str(trip.id), "payload": payload})


def _credential_request_hash(*, trip: Trip, token: str) -> str:
    return hash_request({"trip": str(trip.id), "token": token})


def _ticket_from_idempotency_record(record: IdempotencyKey) -> Ticket:
    response_body: dict[str, Any] = record.response_body or {}
    return Ticket.objects.get(pk=response_body["ticket_id"])


def _board(
    *,
    trip: Trip,
    resolve: Callable[[], Ticket],
    validated_by: User,
    idempotency_key: str,
    request_hash: str,
    **audit_metadata: Any,
) -> Ticket:
    """Everything a validation does once the `Ticket` has been found —
    shared verbatim by `validate_ticket` and `validate_credential`.

    `resolve` is called **inside** the transaction because finding the
    ticket is itself part of the locked section: it takes the
    `select_for_update()` these checks depend on. It raises whichever
    typed exception fits how its own lookup failed
    (`UnknownTicket`, `NoTicketForCredential`, …); this function never
    interprets that.

    Kept as one body rather than copied per entry point on purpose. The
    already-boarded reconciliation below is the fix for a real race
    (docs/specs/6-ticketing.md's Slice 2 note) and is precisely the kind
    of subtlety a second copy loses.
    """
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
        with transaction.atomic():
            ticket = resolve()

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

            # Local import, not module-level: apps.booking.services
            # already imports this module at the top (for issue_ticket),
            # so a module-level import back here would be circular.
            from apps.booking.services import mark_booking_completed_if_fully_boarded

            mark_booking_completed_if_fully_boarded(booking=ticket.booking)

            IdempotencyKey.objects.create(
                client_id=client_id,
                endpoint=_VALIDATE_IDEMPOTENCY_ENDPOINT,
                key=idempotency_key,
                request_hash=request_hash,
                response_status=200,
                response_body={"ticket_id": str(ticket.id)},
            )
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
        actor=validated_by,
        action="ticket.boarded",
        target=ticket,
        client_id=client_id,
        **audit_metadata,
    )
    return ticket


def validate_ticket(
    *, trip: Trip, payload: str, validated_by: User, idempotency_key: str
) -> Ticket:
    """The validator action (`POST /trips/{id}/tickets/validate/`) for a
    scanned QR payload. Idempotency follows
    `apps.tapngo.services.record_tap`'s exact shape: the idempotency-key
    lookup happens first (a replay of an already-failed attempt re-fails
    the same way, not treated as a fresh attempt against
    possibly-changed state), then signature verification, then
    trip-match/time-window/status checks — each of which raises its own
    typed exception rather than a generic one, so the view layer can map
    each to the exact status code docs/specs/6-ticketing.md's edge cases
    enumerate.
    """

    def resolve() -> Ticket:
        try:
            claims = signing.verify_and_decode(payload=payload)
        except signing.TicketSigningError as exc:
            raise InvalidSignature(str(exc)) from exc

        if claims["trip_id"] != str(trip.id):
            raise WrongTrip("This ticket was not issued for this trip.")

        try:
            # By `ticket_id`, not `seat_reservation_id`: an open-seating
            # ticket has no reservation, so the old key could not
            # identify one (docs/specs/10-booking-modes.md).
            return Ticket.objects.select_for_update().get(pk=UUID(claims["ticket_id"]))
        except Ticket.DoesNotExist as exc:
            raise UnknownTicket("No ticket matches this payload.") from exc

    return _board(
        trip=trip,
        resolve=resolve,
        validated_by=validated_by,
        idempotency_key=idempotency_key,
        request_hash=_validate_request_hash(trip=trip, payload=payload),
    )


def validate_credential(
    *, trip: Trip, token: str, validated_by: User, idempotency_key: str
) -> Ticket:
    """The same validator action reached with a `TapCredential` instead
    of a QR payload — docs/specs/10-booking-modes.md's universal tap.

    A passenger may legitimately hold several tickets on one trip (a
    group open-seating booking, or two seats in reservation mode). One
    credential tapped N times boards them one at a time, oldest first;
    refusing as "ambiguous" would break group travel outright.

    The credential itself is resolved *before* the idempotency-key
    lookup, unlike the payload path's signature check. The one
    difference that makes: a replay whose credential was revoked in the
    meantime is refused rather than replayed. That is the safer
    direction, and the window is a retry seconds wide.
    """
    if trip.fare_collection_mode != Business.FareCollectionMode.PREPAID:
        raise TripNotPrepaid(
            "This trip is pay-as-you-go, so it sells no tickets. Record a board tap instead."
        )
    credential = resolve_credential(token)
    if not credential.is_active:
        # Reuses apps.tapngo's own exception rather than declaring a
        # second one meaning the same thing — a revoked credential is
        # revoked regardless of which reader it was presented to.
        raise CredentialInactive("This tap credential has been revoked.")

    def resolve() -> Ticket:
        # Two queries rather than one `booking__passenger` filter, so
        # the locking SELECT carries no join: `FOR UPDATE` would
        # otherwise lock the joined Booking (and User) rows too.
        booking_ids = list(
            Booking.objects.filter(trip=trip, passenger=credential.passenger).values_list(
                "id", flat=True
            )
        )
        # The whole (small) set is locked, not `.filter(status=ISSUED)
        # .first()`: under `FOR UPDATE` a LIMIT 1 can come back empty
        # for a racing second tap even while another unboarded ticket
        # exists, because the plan has already fixed its candidate row.
        tickets = list(
            Ticket.objects.select_for_update()
            .filter(trip=trip, booking_id__in=booking_ids)
            .order_by("issued_at", "passenger_index", "id")
        )
        if not tickets:
            raise NoTicketForCredential("No ticket was found for this credential on this trip.")
        for ticket in tickets:
            if ticket.status == Ticket.Status.ISSUED:
                return ticket
        # None boardable. Hand back the first anyway and let the shared
        # body say *why* — already boarded, revoked or expired — rather
        # than collapsing three different situations into one message.
        return tickets[0]

    return _board(
        trip=trip,
        resolve=resolve,
        validated_by=validated_by,
        idempotency_key=idempotency_key,
        request_hash=_credential_request_hash(trip=trip, token=token),
        credential_id=str(credential.id),
    )
