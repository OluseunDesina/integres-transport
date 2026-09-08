"""Shared helpers for webhook tests — computing a real HMAC-SHA512
signature the same way apps.payments.psp.paystack.verify_webhook_signature
checks it, and building a minimal, realistic Paystack payload."""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

from django.conf import settings


def paystack_payload(
    *, event: str, reference: str, channel: str | None = None
) -> dict[str, Any]:
    """`channel` is omitted by default rather than defaulted to a value.

    docs/specs/16-operational-analytics.md slice 1 reads `data.channel`,
    and every caller written before it sends a payload without one — so
    "the key is absent" is the shape most of this suite exercises, and
    it must stay the shape it exercises. Pass `channel=` only in the
    tests that are about the channel.
    """
    data: dict[str, Any] = {
        "reference": reference,
        "amount": 0,
        "currency": "NGN",
        "customer": {"email": "passenger@example.com"},
    }
    if channel is not None:
        data["channel"] = channel
    return {"event": event, "data": data}


def signed_body(payload: dict[str, Any]) -> tuple[bytes, str]:
    """Returns `(raw_body, signature)` for the given payload, signed
    exactly the way `verify_webhook_signature` checks it."""
    raw_body = json.dumps(payload).encode()
    signature = hmac.new(
        settings.PAYSTACK_WEBHOOK_SECRET.encode(), raw_body, hashlib.sha512
    ).hexdigest()
    return raw_body, signature
