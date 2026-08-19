"""The only module that talks to Paystack's HTTP API — every
Paystack-specific detail (base URL, kobo/minor-unit conversion, HMAC
signing scheme) is confined here so `apps.payments.services` never
needs to know about them. This is this backend's first-ever outbound
third-party HTTP integration.

Settings (`PAYSTACK_SECRET_KEY`/`PAYSTACK_WEBHOOK_SECRET`) are read
lazily inside each function, never at module import time — keeps this
module trivially testable via `override_settings` and matches every
other settings-dependent function in this codebase.
"""

import hashlib
import hmac
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

import requests
from django.conf import settings

_BASE_URL = "https://api.paystack.co"
_REQUEST_TIMEOUT_SECONDS = 10


class PaystackAPIError(Exception):
    """Any Paystack failure — non-2xx response, network error, timeout,
    or a `{"status": false}` body — collapsed to one exception type so
    callers never need to know about `requests`'s own exception
    hierarchy."""


def _to_minor_units(amount: Decimal) -> int:
    """Paystack takes amounts in the smallest currency unit (kobo for
    NGN). Defensive `quantize` even though `PaymentIntent.amount` is
    already a 2-decimal-place field with no smaller fraction possible
    in practice."""
    return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def initialize_transaction(
    *, email: str, amount: Decimal, currency: str, reference: str
) -> dict[str, Any]:
    """`POST /transaction/initialize`. `amount` is major-unit `Decimal`
    (matching every other money field in this codebase) — the kobo
    conversion happens inside this function, not pushed onto the
    caller. Returns the response's `data` dict
    (`{authorization_url, access_code, reference}`)."""
    try:
        response = requests.post(
            f"{_BASE_URL}/transaction/initialize",
            headers={"Authorization": f"Bearer {settings.PAYSTACK_SECRET_KEY}"},
            json={
                "email": email,
                "amount": _to_minor_units(amount),
                "currency": currency,
                "reference": reference,
            },
            timeout=_REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise PaystackAPIError(f"Paystack initialize call failed: {exc}") from exc
    body = response.json()
    if not body.get("status"):
        raise PaystackAPIError(f"Paystack initialize call rejected: {body.get('message')}")
    return dict(body["data"])


def initiate_transfer(
    *, recipient_code: str, amount: Decimal, currency: str, reference: str
) -> dict[str, Any]:
    """`POST /transfer` — Phase 5 Slice 3. `source` is always
    `"balance"`: Integra's own platform-level Paystack balance, per the
    merchant-of-record model (`docs/specs/5-payments-wallet-ledger.md`'s
    "Merchant-of-record decision") — there is no per-Business Paystack
    account to transfer *from*. `amount` is major-unit `Decimal`,
    converted to minor units the same way `initialize_transaction`
    does. Returns the response's `data` dict
    (`{transfer_code, reference, status}`)."""
    try:
        response = requests.post(
            f"{_BASE_URL}/transfer",
            headers={"Authorization": f"Bearer {settings.PAYSTACK_SECRET_KEY}"},
            json={
                "source": "balance",
                "amount": _to_minor_units(amount),
                "recipient": recipient_code,
                "currency": currency,
                "reference": reference,
            },
            timeout=_REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise PaystackAPIError(f"Paystack transfer call failed: {exc}") from exc
    body = response.json()
    if not body.get("status"):
        raise PaystackAPIError(f"Paystack transfer call rejected: {body.get('message')}")
    return dict(body["data"])


def verify_webhook_signature(*, raw_body: bytes, signature: str) -> bool:
    """HMAC-SHA512 of `raw_body` using `PAYSTACK_SECRET_KEY`, compared
    via `hmac.compare_digest`. Paystack's real API signs webhooks with
    the same secret used for API calls — no distinct "webhook secret"
    concept exists in their product, unlike Stripe;
    `PAYSTACK_WEBHOOK_SECRET` is kept as its own setting anyway so this
    function doesn't hardcode that Paystack-specific detail."""
    if not signature:
        return False
    computed = hmac.new(
        settings.PAYSTACK_WEBHOOK_SECRET.encode(), raw_body, hashlib.sha512
    ).hexdigest()
    return hmac.compare_digest(computed, signature)
