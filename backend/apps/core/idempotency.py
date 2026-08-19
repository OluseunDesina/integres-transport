"""Generic idempotency-key handling built on `apps.core.models.IdempotencyKey`.

`apps.booking.services.create_booking` is the first real consumer
(docs/specs/4-fares-seating-booking.md §3) — `apps.payments` is expected
to reuse this in Phase 5 (docs/architecture.md §5's own note on
`IdempotencyKey` being "ready for Phase 5's payment endpoints").
"""

import hashlib
import json
from typing import Any


class IdempotencyKeyConflict(Exception):
    """Raised when the same (client, endpoint, key) is replayed with a
    genuinely different request body than the one that first used it —
    mapped to a 409 by the view layer, never a silently-served stale
    response or a second write. See
    docs/specs/4-fares-seating-booking.md §6."""


def hash_request(payload: dict[str, Any]) -> str:
    """Deterministic hash of a request payload, for comparison against
    `IdempotencyKey.request_hash`. `sort_keys=True` makes the hash
    independent of dict-construction order; `default=str` covers UUID/
    Decimal/date values a caller might pass without every caller having
    to pre-stringify its own payload."""
    canonical = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()
