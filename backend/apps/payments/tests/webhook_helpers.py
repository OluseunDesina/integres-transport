"""Shared helpers for webhook tests — computing a real HMAC-SHA512
signature the same way apps.payments.psp.paystack.verify_webhook_signature
checks it, and building a minimal, realistic Paystack payload."""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

from django.conf import settings


def paystack_payload(*, event: str, reference: str) -> dict[str, Any]:
    return {
        "event": event,
        "data": {
            "reference": reference,
            "amount": 0,
            "currency": "NGN",
            "customer": {"email": "passenger@example.com"},
        },
    }


def signed_body(payload: dict[str, Any]) -> tuple[bytes, str]:
    """Returns `(raw_body, signature)` for the given payload, signed
    exactly the way `verify_webhook_signature` checks it."""
    raw_body = json.dumps(payload).encode()
    signature = hmac.new(
        settings.PAYSTACK_WEBHOOK_SECRET.encode(), raw_body, hashlib.sha512
    ).hexdigest()
    return raw_body, signature
