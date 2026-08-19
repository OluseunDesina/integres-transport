# ADR-0005: QR ticket signing scheme

Status: **Accepted** (2026-08-18). All three open questions below are
now resolved; this unblocks the Phase 6 (ticketing) spec, per the rule
in CLAUDE.md's Known Phase 0 limitations section that names this ADR
as the one still gating it.

## Context

Tickets carry a signed QR payload. The brief requires the signing scheme, payload format, key rotation and revocation to be settled in v1 even though the Flutter validator app (and offline validation) land later, because changing the scheme after tickets have been issued means every issued ticket format changes retroactively.

## Decision

**Signing is asymmetric — Ed25519 — rather than symmetric HMAC.** Reasoning: offline validation (deferred to v2, but explicitly must not require a payload redesign) needs the validator device to verify a ticket's signature without holding a shared secret it could leak or that would need per-device rotation. Ed25519 has mature libraries on both the issuing side (Python — `PyNaCl`/`cryptography`) and the future validation side (Dart — `pointycastle`/`cryptography` package), keeping issuance and future offline-validator implementations aligned on the same primitive. Confirmed by direct investigation before deciding: no asymmetric-signing dependency exists in `backend/pyproject.toml` today, so this is a new dependency Phase 6 adds, not a reuse of anything already in place — the only precedent this ADR extends is the *storage idiom* for a signing secret (below), not any crypto code.

The payload includes a `kid` (key id) claim from day one, so key rotation is a matter of publishing a new key under a new `kid` and continuing to honor recently-retired keys for a grace window — not a payload format change.

### Payload schema and serialization

**The payload is CBOR, not JSON, with UUID fields packed as raw 16-byte binary rather than hyphenated ASCII strings**, and the whole signed blob is base64url-encoded as the QR code's text content. Fields: `booking_id`, `seat_reservation_id` (this doubles as the ticket's own identity for QR purposes — no separate `Ticket` model is required by this decision; whether Phase 6 introduces one for other reasons, e.g. a dedicated issuance/void audit trail, is that spec's own call), `trip_id`, `seat_id`, `from_stop_id`, `to_stop_id` (an explicit stop pair, matching `apps.seating.models.SeatReservation`'s own API-facing shape — its internal `segment_range` is documented as never serialized in an API response, so the QR payload follows that same rule rather than exposing the internal range), `issued_at`/`expires_at` (Unix epoch seconds, not ISO-8601 strings), `kid`, and the raw 64-byte Ed25519 signature over the CBOR-encoded claim map.

Reasoning: five UUID fields alone cost roughly 180 bytes as hyphenated ASCII strings before any framing or signature overhead; packed as raw binary under CBOR's compact map encoding, the same fields cost roughly 80 bytes — keeping the full signed payload under roughly 250 bytes. That number matters concretely for QR *scan reliability*, not code elegance: a lower-version QR code scans more reliably off a phone screen through a validator device's camera under real-world conditions (motion, low light, cheap hardware). JSON was rejected specifically because this payload is produced and consumed entirely by code on both ends (Python issuance, Dart validation) — JSON's one real advantage, human-debuggability, doesn't apply here, while its ASCII-string overhead works directly against the actual constraint.

### Key storage and rotation

**The Ed25519 signing key(s) are `config()`-sourced environment variables**, extending `SECRET_KEY`/`PAYSTACK_SECRET_KEY`'s own established precedent in `backend/config/settings/base.py` — no default in `staging`/`production` (a missing key must fail loudly, not silently sign with nothing), a fixed insecure default in `local`/`ci`. Because ticket signing needs `kid`-based rotation from day one (unlike `SECRET_KEY`'s single-value shape), the setting is `TICKET_SIGNING_KEYS` — a JSON object mapping `kid → base64-encoded Ed25519 private key` — plus `TICKET_SIGNING_ACTIVE_KID`, naming which entry issuance uses for new tickets; every other entry in `TICKET_SIGNING_KEYS` is a still-honored, recently-retired key kept only for validating already-issued, not-yet-expired tickets.

Real AWS Secrets Manager/SSM-backed storage and rotation tooling is documented but unbuilt, same treatment Phase 0 gave AWS provisioning generally — Phase 6 provisions the `config()` env-var path now, and swapping its source to a real Secrets Manager read later is a deployment-layer change, not a payload- or signing-code change, so it doesn't block Phase 6 implementation.

For the validator side, a new `GET /ticketing/signing-keys/` endpoint (JWKS-shaped: `{"keys": [{"kid": ..., "public_key": ...}]}`) publishes every currently-active-or-grace-window public key. The validator app fetches and caches this whenever it has connectivity, trusting the cached copy while offline — the same sync-while-online, trust-the-cache-while-offline shape the revocation mechanism below also uses.

### Revocation vs. offline validation

**Revocation is bounded by a deliberately short `expires_at`, not solved by a real-time check.** Every ticket payload is valid only for a short window around its trip's scheduled service — the exact window length is Phase 6 spec's call, not fixed here — so a cancelled or refunded ticket's signature stops being honorable within that same short window regardless of whether any validator ever learns the ticket was cancelled.

This is deliberately not `apps.tapngo`'s answer to a structurally similar problem: `TapCredential` revocation is a plain `is_active` boolean flag, checked on every live `record_tap` database lookup (`apps/tapngo/services.py`). That works for tap-and-go only because its validation is *always online by design* — `docs/specs/4b-tap-and-go.md` says as much directly. Ticketing's whole reason for existing per this ADR's own Context is a scheme that still works for a genuinely *offline* v2 validator without a payload redesign, so a DB-backed boolean flag is structurally unreachable from the device that would need to check it — not a worse option here, an impossible one. That's the concrete reason this question couldn't just copy tapngo's mechanism.

As defense-in-depth on top of the expiry bound, not a replacement for it, issuance also publishes `GET /ticketing/revoked/`, listing cancelled/refunded ticket ids that are still inside their own not-yet-expired window, synced and cached by the validator on the same online-sync/offline-cache basis as the signing-keys endpoint above. An offline validator that hasn't synced since a ticket was revoked can still be fooled by it — but only for the remainder of that ticket's own short expiry window, a named and bounded residual risk, not an unbounded one, in the same spirit `docs/adr/0007` named the Botswana PSP gap rather than hiding it. Phase 6's spec owns the actual expiry-window length and revocation-list sync cadence; this ADR only settles that the mechanism is expiry-bound-plus-best-effort-sync, never a hard real-time revocation guarantee.

## Consequences

Phase 6's ticket-issuance code is written once against this scheme rather than needing a migration of already-issued tickets: a CBOR-encoded, binary-UUID payload; `TICKET_SIGNING_KEYS`/`TICKET_SIGNING_ACTIVE_KID` as the key-storage setting names; and two new read endpoints (`GET /ticketing/signing-keys/`, `GET /ticketing/revoked/`) the validator syncs against whenever it has connectivity. The revocation-vs-offline tension the original version of this ADR left open is now resolved, not deferred: a short expiry bounds the exposure, a synced revocation list narrows it further when connectivity allows, and the residual gap — an offline validator that hasn't synced recently — is named rather than hidden.

Phase 6's spec still owns: whether a dedicated `Ticket` model exists beyond reusing `SeatReservation`'s own id (e.g. for a richer issuance/void audit trail), the actual expiry-window and revocation-sync-cadence values, and the Dart-side implementation against `pointycastle`/`cryptography` already named above.
