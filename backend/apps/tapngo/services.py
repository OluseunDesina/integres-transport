"""Fat-service layer for apps.tapngo — see docs/specs/4b-tap-and-go.md.

`record_tap` mirrors `apps.booking.services.create_booking`'s
idempotency-key shape (wrap the whole attempt in one
`IdempotencyKey`-guarded `transaction.atomic()` block) and
`apps.seating.services.create_reservation`'s "always attempt the write,
let the database's own constraint decide" discipline for the
one-open-journey-per-passenger invariant.
"""

from __future__ import annotations

import hashlib
import secrets
from typing import Any

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.businesses.models import Business
from apps.core.audit import record_audit_event
from apps.core.idempotency import IdempotencyKeyConflict, hash_request
from apps.core.models import IdempotencyKey
from apps.fares.services import FareNotConfigured, get_fare
from apps.identity.models import User
from apps.network.models import RouteStop, Stop
from apps.scheduling.models import Trip

from .models import FareJourney, TapCredential, TapEvent

_TAP_IDEMPOTENCY_ENDPOINT = "tapngo.tap"


class UnknownToken(Exception):
    """No TapCredential matches this token — mapped to 404."""


class CredentialInactive(Exception):
    """Credential exists but has been revoked — mapped to 403."""


class TripNotTapAndGo(Exception):
    """Trip.booking_mode != TAP_AND_GO — mapped to 400."""


class TripNotOpenForTaps(Exception):
    """Trip.status is not SCHEDULED or IN_PROGRESS — mapped to 400."""


class StopNotOnRoute(Exception):
    """Board or alight stop isn't on the trip's route — mapped to 400."""


class OpenJourneyExists(Exception):
    """A board tap collided with the one-open-journey-per-passenger
    constraint — mapped to 409. The database's own partial unique index
    is the source of truth (mirrors docs/adr/0004's reasoning for
    `SeatUnavailable`); this is never pre-checked."""


class NoOpenJourney(Exception):
    """An alight tap has no matching open journey for this credential on
    this trip — mapped to 404. No TapEvent row is written for this
    rejection (spec edge case 2)."""


class InvalidAlightStop(Exception):
    """Alight stop is the same as, or precedes, the board stop on the
    route — mapped to 400. No TapEvent row is written for this rejection
    (spec edge cases 3-4); the journey stays open."""


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_credential(*, passenger: User, channel: str, label: str) -> tuple[TapCredential, str]:
    """Returns `(credential, token)` — `token` is the only time the raw
    value is ever available; only its hash is persisted."""
    token = secrets.token_urlsafe(32)
    # `User.client` is nullable at the type level (NULL for platform
    # staff, docs/adr/0003) but a passenger issuing their own tap
    # credential always has one — only client-scoped users reach this
    # endpoint (IsAuthenticated + the credential is always "mine").
    assert passenger.client is not None
    credential = TapCredential.objects.create(
        client=passenger.client,
        passenger=passenger,
        token_hash=_hash_token(token),
        channel=channel,
        label=label,
    )
    record_audit_event(
        actor=passenger, action="tap_credential.issued", target=credential, channel=channel
    )
    return credential, token


def revoke_credential(*, credential: TapCredential, revoked_by: User) -> TapCredential:
    credential.is_active = False
    credential.save(update_fields=["is_active"])
    record_audit_event(actor=revoked_by, action="tap_credential.revoked", target=credential)
    return credential


def _resolve_credential(token: str) -> TapCredential:
    try:
        return TapCredential.objects.select_related("passenger").get(token_hash=_hash_token(token))
    except TapCredential.DoesNotExist:
        raise UnknownToken("Unknown tap credential.") from None


def _validate_trip_for_taps(trip: Trip) -> None:
    if trip.booking_mode != Business.BookingMode.TAP_AND_GO:
        raise TripNotTapAndGo("This trip does not use tap-and-go.")
    if trip.status not in (Trip.Status.SCHEDULED, Trip.Status.IN_PROGRESS):
        raise TripNotOpenForTaps("This trip is not open for taps.")


def _stop_sequence(*, route_id: Any, stop: Stop) -> int:
    """Mirrors apps.seating.services._segment_sequence_range's own
    RouteStop lookup, one stop at a time (tap-and-go resolves board and
    alight independently, not as a single pair, since they arrive as two
    separate requests)."""
    route_stop = RouteStop.objects.filter(route_id=route_id, stop=stop).first()
    if route_stop is None:
        raise StopNotOnRoute("This stop is not on the trip's route.")
    return route_stop.sequence


def _tap_request_hash(*, trip: Trip, token: str, tap_type: str, stop: Stop) -> str:
    return hash_request(
        {"trip": str(trip.id), "token": token, "tap_type": tap_type, "stop": str(stop.id)}
    )


def _tap_event_from_idempotency_record(record: IdempotencyKey) -> TapEvent:
    response_body: dict[str, Any] = record.response_body or {}
    return TapEvent.objects.get(pk=response_body["tap_event_id"])


def _record_board(
    *, trip: Trip, business: Business, credential: TapCredential, stop: Stop
) -> TapEvent:
    _stop_sequence(route_id=trip.route_id, stop=stop)
    now = timezone.now()
    try:
        with transaction.atomic():
            journey = FareJourney.objects.create(
                client=trip.client,
                business=business,
                trip=trip,
                passenger=credential.passenger,
                credential=credential,
                board_stop=stop,
                status=FareJourney.Status.OPEN,
                boarded_at=now,
            )
    except IntegrityError as exc:
        raise OpenJourneyExists("This passenger already has an open tap-and-go journey.") from exc

    tap_event = TapEvent.objects.create(
        client=trip.client,
        business=business,
        trip=trip,
        credential=credential,
        journey=journey,
        tap_type=TapEvent.TapType.BOARD,
        stop=stop,
        tapped_at=now,
    )
    record_audit_event(actor=credential.passenger, action="fare_journey.opened", target=journey)
    record_audit_event(
        actor=credential.passenger, action="tap_event.recorded", target=tap_event, tap_type="board"
    )
    return tap_event


def _record_alight(
    *, trip: Trip, business: Business, credential: TapCredential, stop: Stop
) -> TapEvent:
    journey = (
        FareJourney.objects.select_for_update()
        .select_related("board_stop")
        .filter(business=business, passenger=credential.passenger, status=FareJourney.Status.OPEN)
        .first()
    )
    if journey is None or journey.trip_id != trip.id:
        raise NoOpenJourney("No open journey found for this credential on this trip.")

    board_sequence = _stop_sequence(route_id=trip.route_id, stop=journey.board_stop)
    alight_sequence = _stop_sequence(route_id=trip.route_id, stop=stop)
    if alight_sequence <= board_sequence:
        raise InvalidAlightStop("The alight stop must come after the board stop on the route.")

    now = timezone.now()
    tap_event = TapEvent.objects.create(
        client=trip.client,
        business=business,
        trip=trip,
        credential=credential,
        journey=journey,
        tap_type=TapEvent.TapType.ALIGHT,
        stop=stop,
        tapped_at=now,
    )

    try:
        quote = get_fare(trip=trip, from_stop=journey.board_stop, to_stop=stop)
    except FareNotConfigured:
        # Deliberately different from the booking flow's 404-and-reject
        # (spec edge case 5): the passenger already physically rode the
        # vehicle, so the alight tap itself is not rejected — the
        # journey degrades to needs_review instead of closing priced.
        journey.alight_stop = stop
        journey.alighted_at = now
        journey.status = FareJourney.Status.NEEDS_REVIEW
        journey.save(update_fields=["alight_stop", "alighted_at", "status"])
        record_audit_event(
            actor=credential.passenger, action="fare_journey.needs_review", target=journey
        )
    else:
        journey.alight_stop = stop
        journey.alighted_at = now
        journey.status = FareJourney.Status.CLOSED
        journey.amount = quote.amount
        journey.currency = quote.currency
        journey.fare_rule = quote.fare_rule
        journey.fare_segment_rule = quote.fare_segment_rule
        journey.save(
            update_fields=[
                "alight_stop",
                "alighted_at",
                "status",
                "amount",
                "currency",
                "fare_rule",
                "fare_segment_rule",
            ]
        )
        record_audit_event(
            actor=credential.passenger,
            action="fare_journey.closed",
            target=journey,
            amount=str(quote.amount),
        )

    record_audit_event(
        actor=credential.passenger,
        action="tap_event.recorded",
        target=tap_event,
        tap_type="alight",
    )
    return tap_event


def record_tap(
    *, trip: Trip, token: str, tap_type: str, stop: Stop, idempotency_key: str
) -> TapEvent:
    """The validator action (`POST /trips/{id}/taps/`). Idempotency
    follows `apps.booking.services.create_booking`'s exact shape: only a
    *successful* attempt is memorized, a matching replay returns the
    original `TapEvent`, a same-key-different-body replay raises
    `IdempotencyKeyConflict`.

    Validation order matters: the idempotency-key lookup happens first
    (a replay of an already-failed attempt should re-fail the same way,
    not be treated as a fresh attempt against possibly-changed state),
    then trip/credential validation, then the board/alight-specific
    logic — each of which raises its own typed exception rather than a
    generic one, so the view layer can map each to the exact status code
    the spec's edge cases enumerate.
    """
    request_hash = _tap_request_hash(trip=trip, token=token, tap_type=tap_type, stop=stop)
    client_id = str(trip.client_id)

    existing = IdempotencyKey.objects.filter(
        client_id=client_id, endpoint=_TAP_IDEMPOTENCY_ENDPOINT, key=idempotency_key
    ).first()
    if existing is not None:
        if existing.request_hash != request_hash:
            raise IdempotencyKeyConflict(
                "This Idempotency-Key was already used for a different request."
            )
        return _tap_event_from_idempotency_record(existing)

    _validate_trip_for_taps(trip)
    credential = _resolve_credential(token)
    if not credential.is_active:
        raise CredentialInactive("This tap credential has been revoked.")

    business = trip.business

    try:
        with transaction.atomic():
            if tap_type == TapEvent.TapType.BOARD:
                tap_event = _record_board(
                    trip=trip, business=business, credential=credential, stop=stop
                )
            else:
                tap_event = _record_alight(
                    trip=trip, business=business, credential=credential, stop=stop
                )

            IdempotencyKey.objects.create(
                client_id=client_id,
                endpoint=_TAP_IDEMPOTENCY_ENDPOINT,
                key=idempotency_key,
                request_hash=request_hash,
                response_status=201,
                response_body={"tap_event_id": str(tap_event.id)},
            )
    except IntegrityError:
        # Reachable only for the IdempotencyKey race itself
        # (`unique_idempotency_key_per_client_endpoint`) — the
        # one-open-journey partial unique constraint's IntegrityError is
        # already caught and translated to OpenJourneyExists inside
        # _record_board's own nested transaction.atomic(), the same
        # nested-atomic-plus-distinct-exception shape
        # apps.booking.services.create_booking uses around
        # apps.seating.services.create_reservation's SeatUnavailable.
        record = IdempotencyKey.objects.get(
            client_id=client_id, endpoint=_TAP_IDEMPOTENCY_ENDPOINT, key=idempotency_key
        )
        if record.request_hash != request_hash:
            raise IdempotencyKeyConflict(
                "This Idempotency-Key was already used for a different request."
            ) from None
        return _tap_event_from_idempotency_record(record)

    return tap_event
