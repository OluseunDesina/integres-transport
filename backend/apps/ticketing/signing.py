"""The only module that touches CBOR/Ed25519 details for ticket QR
payloads — apps.ticketing.services never imports cbor2/nacl directly.
Settings are read lazily inside each function, never at module import
time, matching apps.payments.psp.paystack's own precedent (keeps this
module trivially testable via override_settings).

Payload shape is docs/adr/0005's own decision: a CBOR-encoded claim map
with UUID fields packed as raw 16-byte binary (not hyphenated ASCII
strings) and Unix-epoch-second timestamps, signed with Ed25519, the
64-byte signature prepended to the CBOR bytes and the whole thing
base64url-encoded (padding stripped) as the QR's text content.
"""

import base64
import json
from datetime import datetime
from typing import TypedDict
from uuid import UUID

import cbor2
from django.conf import settings
from nacl.exceptions import BadSignatureError, CryptoError
from nacl.signing import SigningKey

_SIGNATURE_LENGTH = 64


class TicketSigningError(Exception):
    """Any failure verifying or decoding a ticket payload — malformed
    base64, malformed CBOR, an unknown `kid`, or a bad signature all
    collapse to this one exception. From a validator's point of view
    all four are equally untrustworthy; callers must never distinguish
    between them (see docs/specs/6-ticketing.md's edge case 8)."""


class TicketClaims(TypedDict):
    booking_id: str
    seat_reservation_id: str
    trip_id: str
    seat_id: str
    from_stop_id: str
    to_stop_id: str
    issued_at: int
    expires_at: int
    kid: str


def _signing_keys() -> dict[str, str]:
    """`{kid: base64-encoded Ed25519 private key}`, straight from
    `TICKET_SIGNING_KEYS`. Presence of a `kid` in this dict is the
    entire grace-window mechanism (see docs/specs/6-ticketing.md's
    "Correction made during implementation" note) — an operator ends a
    retired key's grace period by removing it here and redeploying."""
    return dict(json.loads(settings.TICKET_SIGNING_KEYS))


def _uuid_to_bytes(value: str) -> bytes:
    return UUID(str(value)).bytes


def _uuid_from_bytes(value: bytes) -> str:
    return str(UUID(bytes=value))


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def sign_ticket(
    *,
    booking_id: str,
    seat_reservation_id: str,
    trip_id: str,
    seat_id: str,
    from_stop_id: str,
    to_stop_id: str,
    issued_at: datetime,
    expires_at: datetime,
) -> str:
    """Signs with `TICKET_SIGNING_ACTIVE_KID`'s private key. Returns the
    base64url QR payload text."""
    kid = settings.TICKET_SIGNING_ACTIVE_KID
    keys = _signing_keys()
    signing_key = SigningKey(base64.b64decode(keys[kid]))
    claims = {
        "booking_id": _uuid_to_bytes(booking_id),
        "seat_reservation_id": _uuid_to_bytes(seat_reservation_id),
        "trip_id": _uuid_to_bytes(trip_id),
        "seat_id": _uuid_to_bytes(seat_id),
        "from_stop_id": _uuid_to_bytes(from_stop_id),
        "to_stop_id": _uuid_to_bytes(to_stop_id),
        "issued_at": int(issued_at.timestamp()),
        "expires_at": int(expires_at.timestamp()),
        "kid": kid,
    }
    encoded_claims = cbor2.dumps(claims)
    signed = signing_key.sign(encoded_claims)
    return _b64url_encode(bytes(signed))


def verify_and_decode(*, payload: str) -> TicketClaims:
    """Verifies the Ed25519 signature and returns the decoded claims
    only on success. Never returns or acts on any claim before the
    signature has been checked against the `kid`-selected public key —
    peeking at `kid` itself before that point is safe (it only selects
    which key to test against; a forged `kid` alongside a genuine
    signature is impossible, since the signature covers the CBOR bytes
    `kid` is embedded in)."""
    try:
        raw = _b64url_decode(payload)
    except Exception as exc:  # noqa: BLE001
        raise TicketSigningError("Malformed ticket payload.") from exc
    if len(raw) <= _SIGNATURE_LENGTH:
        raise TicketSigningError("Malformed ticket payload.")
    signature, encoded_claims = raw[:_SIGNATURE_LENGTH], raw[_SIGNATURE_LENGTH:]

    try:
        claims = cbor2.loads(encoded_claims)
    except Exception as exc:  # noqa: BLE001
        raise TicketSigningError("Malformed ticket payload.") from exc

    kid = claims.get("kid")
    keys = _signing_keys()
    if not isinstance(kid, str) or kid not in keys:
        raise TicketSigningError("Unknown or retired signing key.")

    signing_key = SigningKey(base64.b64decode(keys[kid]))
    verify_key = signing_key.verify_key
    try:
        verify_key.verify(signature + encoded_claims)
    except (BadSignatureError, CryptoError) as exc:
        raise TicketSigningError("Invalid ticket signature.") from exc

    try:
        return TicketClaims(
            booking_id=_uuid_from_bytes(claims["booking_id"]),
            seat_reservation_id=_uuid_from_bytes(claims["seat_reservation_id"]),
            trip_id=_uuid_from_bytes(claims["trip_id"]),
            seat_id=_uuid_from_bytes(claims["seat_id"]),
            from_stop_id=_uuid_from_bytes(claims["from_stop_id"]),
            to_stop_id=_uuid_from_bytes(claims["to_stop_id"]),
            issued_at=int(claims["issued_at"]),
            expires_at=int(claims["expires_at"]),
            kid=kid,
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise TicketSigningError("Malformed ticket claims.") from exc


def public_keys() -> dict[str, str]:
    """`{kid: base64-encoded Ed25519 public key}` for every `kid`
    currently in `TICKET_SIGNING_KEYS`, derived from each stored private
    key — no separate public-key setting is ever stored. Backs
    `GET /ticketing/signing-keys/`."""
    return {
        kid: base64.b64encode(bytes(SigningKey(base64.b64decode(private_key)).verify_key)).decode()
        for kid, private_key in _signing_keys().items()
    }
