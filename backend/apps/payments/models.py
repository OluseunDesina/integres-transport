"""Paystack payment initiation + webhook handling — Phase 5 Slice 2.
See docs/adr/0007 and docs/specs/5-payments-wallet-ledger.md's
"apps/payments (Slice 2)" section.

Every FK on a `BaseModel` subclass uses `related_name="+"` — matches
`apps.ledger`'s and `apps.tapngo`'s own convention: a reverse accessor
on an RLS-protected model would traverse the same `TenantScopedManager`
that silently empties for platform staff.
"""

import uuid

from django.db import models
from django.db.models import Q

from apps.businesses.models import Business
from apps.core.models import BaseModel
from apps.identity.models import User
from apps.ledger.models import JournalEntry


class PaystackAccount(BaseModel):
    """A Business's payout *destination* reference — not a duplicate
    merchant-credential set. Integra holds one platform-level Paystack
    secret key for every `initialize`/webhook-verify/`transfer` call
    regardless of Business (the merchant-of-record model the spec's own
    "Merchant-of-record decision" section settles) — this model exists
    so `initiate_payment()` can fail closed (ADR-0007) when a Business
    has none configured, and so a future settlement run (Slice 3) knows
    where to pay a Business out."""

    business = models.OneToOneField(Business, on_delete=models.PROTECT, related_name="+")
    recipient_code = models.CharField(max_length=255, blank=True)
    bank_code = models.CharField(max_length=16, blank=True)
    account_number = models.CharField(max_length=32, blank=True)
    account_name = models.CharField(max_length=255, blank=True)
    is_active = models.BooleanField(default=True)
    verified_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"Paystack account for {self.business_id}"


class PaymentIntent(BaseModel):
    """One attempt to pay for a `Booking`, or to top up a passenger's
    wallet (Phase 7 — docs/specs/7-passenger-wallet.md). `psp_reference`
    is generated server-side *before* calling Paystack (see
    `apps.payments.services.initiate_payment`), so a retry under one
    `Idempotency-Key` can't produce two different Paystack transactions.
    `journal_entry` is set exactly once, on `charge.success` — its own
    OneToOne uniqueness is a concurrency guard in its own right (the
    second of two layers the webhook-replay concurrency spike targets,
    alongside `WebhookEvent`'s own unique constraint).

    `booking`/`wallet_business` are mutually exclusive, gated by
    `intent_type` — a booking payment has a `Booking` to pay for and no
    standalone wallet target; a wallet top-up has no `Booking` at all,
    only the `Business` whose wallet is being funded. `business` itself
    stays set for both (denormalized from `booking.business` or equal
    to `wallet_business`) — every existing read path already filters/
    groups by it."""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        SUCCEEDED = "succeeded", "Succeeded"
        FAILED = "failed", "Failed"
        CANCELLED = "cancelled", "Cancelled"

    class IntentType(models.TextChoices):
        BOOKING_PAYMENT = "booking_payment", "Booking payment"
        WALLET_TOPUP = "wallet_topup", "Wallet top-up"

    intent_type = models.CharField(
        max_length=20, choices=IntentType.choices, default=IntentType.BOOKING_PAYMENT
    )
    booking = models.ForeignKey(
        "booking.Booking", on_delete=models.PROTECT, related_name="+", null=True, blank=True
    )
    wallet_business = models.ForeignKey(
        Business, on_delete=models.PROTECT, related_name="+", null=True, blank=True
    )
    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    passenger = models.ForeignKey(User, on_delete=models.PROTECT, related_name="+")
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    currency = models.CharField(max_length=8)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    psp_provider = models.CharField(max_length=32, default="paystack")
    psp_reference = models.CharField(max_length=255, unique=True)
    psp_authorization_url = models.CharField(max_length=500, blank=True)
    succeeded_at = models.DateTimeField(null=True, blank=True)
    failed_at = models.DateTimeField(null=True, blank=True)
    journal_entry = models.OneToOneField(
        JournalEntry, on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    requires_manual_refund = models.BooleanField(default=False)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["booking"],
                condition=Q(status="pending"),
                name="one_pending_payment_intent_per_booking",
            ),
            # `booking IS NULL` for every wallet_topup row, so this
            # stays silently inert for them (Postgres never treats two
            # NULLs as conflicting in a unique index) — no
            # "one pending top-up at a time" rule is needed or implied.
            models.CheckConstraint(
                condition=(
                    Q(
                        intent_type="booking_payment",
                        booking__isnull=False,
                        wallet_business__isnull=True,
                    )
                    | Q(
                        intent_type="wallet_topup",
                        booking__isnull=True,
                        wallet_business__isnull=False,
                    )
                ),
                name="payment_intent_booking_xor_wallet_business",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.psp_reference} ({self.status})"


class WebhookEvent(models.Model):
    """Immutable-in-practice record of one inbound Paystack webhook
    delivery. Deliberately **not** a `BaseModel` subclass — same
    reasoning as `apps.core.models.AuditLog`/`IdempotencyKey`: it must
    be writable before any tenancy context exists, since Paystack calls
    a public, unauthenticated endpoint. Outside the RLS-coverage
    registry test for that reason.

    The `(psp_provider, reference, event_type)` unique constraint is the
    true dedup gate for a duplicate/replayed delivery — a sibling to
    `IdempotencyKey`, not a reuse of it, because this key is
    PSP-supplied, not client-supplied."""

    class ProcessingStatus(models.TextChoices):
        RECEIVED = "received", "Received"
        PROCESSED = "processed", "Processed"
        IGNORED = "ignored", "Ignored"
        FAILED = "failed", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    client_id = models.UUIDField(null=True, blank=True, db_index=True)
    psp_provider = models.CharField(max_length=32)
    event_type = models.CharField(max_length=64)
    reference = models.CharField(max_length=255)
    signature_valid = models.BooleanField()
    raw_payload = models.JSONField()
    payment_intent = models.ForeignKey(
        PaymentIntent, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    processing_status = models.CharField(
        max_length=16, choices=ProcessingStatus.choices, default=ProcessingStatus.RECEIVED
    )
    created_at = models.DateTimeField(auto_now_add=True)
    processed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["psp_provider", "reference", "event_type"],
                name="unique_webhook_event_per_provider_reference_type",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.event_type} {self.reference} ({self.processing_status})"
