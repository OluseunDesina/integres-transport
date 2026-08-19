"""Fat-service layer for apps.payments — see
docs/specs/5-payments-wallet-ledger.md's "apps/payments (Slice 2)"
section.

`initiate_payment` mirrors `apps.booking.services.create_booking`'s
idempotency shape. `process_paystack_webhook`/`_handle_charge_success`
mirror `apps.seating.tasks.expire_seat_holds`'s
`platform_staff_bypass()` discipline — a webhook request has no
authenticated user behind it, so `TenancyMiddleware` never sets a real
tenancy context for it.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.booking.models import Booking
from apps.booking.services import mark_booking_paid
from apps.businesses.models import Business
from apps.core.audit import record_audit_event
from apps.core.idempotency import IdempotencyKeyConflict, hash_request
from apps.core.models import IdempotencyKey
from apps.core.rls import platform_staff_bypass
from apps.identity.models import User
from apps.ledger.models import JournalEntry, SettlementRun
from apps.ledger.services import (
    JournalLineInput,
    claim_settlement_run,
    get_or_create_business_clearing_account,
    get_or_create_commission_account,
    get_or_create_wallet_account,
    post_journal_entry,
)
from apps.seating.services import refresh_seat_holds

from .models import PaymentIntent, PaystackAccount, WebhookEvent
from .psp.paystack import initialize_transaction, initiate_transfer, verify_webhook_signature

logger = logging.getLogger(__name__)

_IDEMPOTENCY_ENDPOINT = "payments.initiate"


class PspNotConfigured(Exception):
    """The Business has no active PaystackAccount — mapped to 404. The
    literal implementation of ADR-0007's "fail closed... with a clear
    error, not a generic 500" directive; this is how the Botswana gap
    actually surfaces to a passenger, with zero country-sniffing logic
    anywhere in this path."""


class PaymentAlreadyPending(Exception):
    """A `pending` PaymentIntent already exists for this booking —
    mapped to 409. DB-enforced by `PaymentIntent`'s own partial unique
    constraint, never pre-checked."""


class BookingNotPayable(Exception):
    """`booking.status != PENDING_PAYMENT` at `initiate_payment()` call
    time — mapped to 409."""


class PayoutDestinationNotConfigured(Exception):
    """The Business has no active `PaystackAccount` with a non-blank
    `recipient_code` — mapped to 404. Distinct from `PspNotConfigured`:
    a Business can have an active `PaystackAccount` (bank details
    captured) with no `recipient_code` yet, since staff configure it
    via a separate PATCH than the one that creates the account.
    ASSUMPTION: the spec doesn't name this precondition explicitly;
    this mirrors `PspNotConfigured`'s existing fail-closed shape
    (ADR-0007) rather than a generic 500."""


def _generate_psp_reference() -> str:
    return f"integra-pay-{uuid.uuid4().hex}"


def _generate_transfer_reference() -> str:
    return f"integra-transfer-{uuid.uuid4().hex}"


def _payment_intent_request_hash(*, booking: Booking, passenger: User) -> str:
    return hash_request({"booking_id": str(booking.id), "passenger": str(passenger.id)})


def _payment_intent_from_idempotency_record(record: IdempotencyKey) -> PaymentIntent:
    response_body = record.response_body or {}
    return PaymentIntent.objects.get(pk=response_body["payment_intent_id"])


def _split_commission(amount: Decimal) -> tuple[Decimal, Decimal]:
    """Returns `(business_share, commission_share)`. `commission_share`
    is the only independently-rounded value; `business_share` is a
    subtraction, never independently rounded, so the two always sum
    exactly to `amount` — required for the ledger entry to balance."""
    rate = settings.INTEGRA_COMMISSION_RATE_PERCENT
    commission_share = (amount * rate / Decimal("100")).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )
    business_share = amount - commission_share
    return business_share, commission_share


def initiate_payment(*, booking: Booking, passenger: User, idempotency_key: str) -> PaymentIntent:
    """Always called from an authenticated passenger request — real
    tenancy context already established by `TenancyMiddleware`, unlike
    the webhook path, so no `platform_staff_bypass()` needed here."""
    if booking.status != Booking.Status.PENDING_PAYMENT:
        raise BookingNotPayable("This booking cannot be paid for in its current state.")

    request_hash = _payment_intent_request_hash(booking=booking, passenger=passenger)
    client_id = str(booking.client_id)

    existing = IdempotencyKey.objects.filter(
        client_id=client_id, endpoint=_IDEMPOTENCY_ENDPOINT, key=idempotency_key
    ).first()
    if existing is not None:
        if existing.request_hash != request_hash:
            raise IdempotencyKeyConflict(
                "This Idempotency-Key was already used for a different request."
            )
        return _payment_intent_from_idempotency_record(existing)

    business = booking.business
    if not PaystackAccount.objects.filter(business=business, is_active=True).exists():
        raise PspNotConfigured("This Business has no active Paystack account configured.")

    reference = _generate_psp_reference()
    try:
        with transaction.atomic():
            # The Paystack call happens first, before any row is
            # written — a PSP failure here leaves nothing to roll back,
            # so a retry under the same Idempotency-Key is clean (the
            # spec's own PSP-downtime failure mode).
            init_data = initialize_transaction(
                email=passenger.email,
                amount=booking.total_amount,
                currency=booking.currency,
                reference=reference,
            )
            intent = PaymentIntent.objects.create(
                client=booking.client,
                booking=booking,
                business=business,
                passenger=passenger,
                amount=booking.total_amount,
                currency=booking.currency,
                status=PaymentIntent.Status.PENDING,
                psp_provider="paystack",
                psp_reference=reference,
                psp_authorization_url=init_data.get("authorization_url", ""),
            )
            refresh_seat_holds(booking=booking, hold_minutes=business.seat_hold_minutes)
            IdempotencyKey.objects.create(
                client_id=client_id,
                endpoint=_IDEMPOTENCY_ENDPOINT,
                key=idempotency_key,
                request_hash=request_hash,
                response_status=201,
                response_body={"payment_intent_id": str(intent.id)},
            )
    except IntegrityError:
        # Two different constraints can raise IntegrityError inside the
        # block above — disambiguate by checking whether the
        # IdempotencyKey record actually got written. If it did, this
        # is a concurrent-duplicate-submission race (create_booking's
        # own shape); if not, the earlier PaymentIntent.create() itself
        # is what hit the partial-unique constraint.
        record = IdempotencyKey.objects.filter(
            client_id=client_id, endpoint=_IDEMPOTENCY_ENDPOINT, key=idempotency_key
        ).first()
        if record is not None:
            if record.request_hash != request_hash:
                raise IdempotencyKeyConflict(
                    "This Idempotency-Key was already used for a different request."
                ) from None
            return _payment_intent_from_idempotency_record(record)
        raise PaymentAlreadyPending("A payment is already pending for this booking.") from None

    record_audit_event(
        actor=passenger, action="payment.initiated", target=intent, amount=str(intent.amount)
    )
    return intent


def configure_paystack_account(
    *,
    business: Business,
    bank_code: str,
    account_number: str,
    account_name: str,
    recipient_code: str = "",
    is_active: bool = True,
    updated_by: User,
) -> PaystackAccount:
    account, created = PaystackAccount.all_objects.update_or_create(
        business=business,
        defaults={
            "client": business.client,
            "bank_code": bank_code,
            "account_number": account_number,
            "account_name": account_name,
            "recipient_code": recipient_code,
            "is_active": is_active,
        },
    )
    record_audit_event(
        actor=updated_by,
        action="paystack_account.configured" if created else "paystack_account.updated",
        target=account,
        client_id=str(business.client_id),
    )
    return account


def trigger_settlement_run(
    *, business: Business, period_start: date, period_end: date, initiated_by: User
) -> SettlementRun:
    """Phase 5 Slice 3. Mirrors `initiate_payment()`'s own discipline:
    the Paystack Transfer call happens *inside* the same
    `transaction.atomic()` block that commits the claim and the
    `SettlementRun` row, so a Transfer-call failure rolls the claim
    back too — a retry (a fresh call for the same still-unclaimed
    period) is clean, no orphaned "claimed but never transferred"
    state to recover from.

    ASSUMPTION: the `recipient_code` precondition below is checked
    unconditionally before claiming, even for a period that would turn
    out to have zero unsettled entries — a minor, accepted
    inefficiency in exchange for matching `initiate_payment()`'s
    fail-fast-before-any-write discipline exactly.

    Uses `PaystackAccount.all_objects` (not `.objects`) under an
    explicit `platform_staff_bypass()` — not just `Business.all_objects`'s
    "no client tenancy context" reasoning, but self-sufficiency: unlike
    `initiate_payment()` (always called from an authenticated passenger
    request, whose middleware has already set a real tenancy context),
    this function must also work called with no request behind it at
    all, the same reason `process_paystack_webhook` opens its own
    bypass rather than relying on `IsPlatformStaff`'s middleware-set RLS
    session vars being present."""
    with platform_staff_bypass():
        account = PaystackAccount.all_objects.filter(business=business, is_active=True).first()
        if account is None or not account.recipient_code:
            raise PayoutDestinationNotConfigured(
                "This Business has no configured Paystack payout destination."
            )

        with transaction.atomic():
            run = claim_settlement_run(
                business=business,
                period_start=period_start,
                period_end=period_end,
                initiated_by=initiated_by,
            )
            if run.total_amount <= Decimal("0.00"):
                # ASSUMPTION: nothing to pay out this period — claiming
                # still happens (so those entries stop showing up as
                # unsettled), but no Paystack call is made for a
                # zero/negative amount. Doesn't conflict with ADR-0006,
                # which only fixes the FK direction and "assignment is
                # a normal unique write", not what happens after the
                # amount is computed.
                run.status = SettlementRun.Status.PAID_OUT
                run.executed_at = timezone.now()
                run.save(update_fields=["status", "executed_at"])
            else:
                reference = _generate_transfer_reference()
                transfer_data = initiate_transfer(
                    recipient_code=account.recipient_code,
                    amount=run.total_amount,
                    currency=run.currency,
                    reference=reference,
                )
                run.status = SettlementRun.Status.PROCESSING
                run.psp_transfer_reference = reference
                run.psp_transfer_status = transfer_data.get("status", "")
                run.save(
                    update_fields=["status", "psp_transfer_reference", "psp_transfer_status"]
                )

    record_audit_event(
        actor=initiated_by,
        action="settlement_run.triggered",
        target=run,
        client_id=str(business.client_id),
        status=run.status,
        total_amount=str(run.total_amount),
    )
    return run


def process_paystack_webhook(*, raw_body: bytes, signature: str) -> int:
    """Never raises — returns the HTTP status the view should send. 401
    only for a bad/missing signature, before any DB write; every other
    path returns 200, per the spec's "avoid Paystack retry storms"
    directive."""
    if not verify_webhook_signature(raw_body=raw_body, signature=signature):
        return 401

    payload = json.loads(raw_body)
    event_type = payload.get("event", "")
    reference = payload.get("data", {}).get("reference", "")

    with platform_staff_bypass():
        event, created = WebhookEvent.objects.get_or_create(
            psp_provider="paystack",
            reference=reference,
            event_type=event_type,
            defaults={
                "raw_payload": payload,
                "signature_valid": True,
                "processing_status": WebhookEvent.ProcessingStatus.RECEIVED,
            },
        )
        if not created:
            # A prior delivery already owns this row — edge case 7.
            return 200

        try:
            _dispatch_webhook_event(event=event, reference=reference)
        except Exception:
            # Never let an exception escape: TenancyMiddleware wraps
            # the whole request in one outer transaction.atomic() — an
            # uncaught exception here would roll back the WebhookEvent
            # row too, silently defeating the dedup gate on the next
            # identical delivery.
            logger.exception(
                "paystack webhook processing failed", extra={"webhook_event_id": str(event.id)}
            )
            WebhookEvent.objects.filter(pk=event.pk).update(
                processing_status=WebhookEvent.ProcessingStatus.FAILED,
                processed_at=timezone.now(),
            )
    return 200


def _dispatch_webhook_event(*, event: WebhookEvent, reference: str) -> None:
    if event.event_type == "charge.success":
        _handle_charge_success(event=event, reference=reference)
    elif event.event_type == "charge.failed":
        _handle_charge_failed(event=event, reference=reference)
    elif event.event_type == "transfer.success":
        _handle_transfer_success(event=event, reference=reference)
    elif event.event_type == "transfer.failed":
        _handle_transfer_failed(event=event, reference=reference)
    else:
        WebhookEvent.objects.filter(pk=event.pk).update(
            processing_status=WebhookEvent.ProcessingStatus.IGNORED, processed_at=timezone.now()
        )


def _handle_charge_success(*, event: WebhookEvent, reference: str) -> None:
    try:
        intent = PaymentIntent.all_objects.select_related("booking", "business", "passenger").get(
            psp_reference=reference
        )
    except PaymentIntent.DoesNotExist:
        WebhookEvent.objects.filter(pk=event.pk).update(
            processing_status=WebhookEvent.ProcessingStatus.IGNORED, processed_at=timezone.now()
        )
        return

    WebhookEvent.objects.filter(pk=event.pk).update(client_id=intent.client_id)

    with transaction.atomic():
        intent = PaymentIntent.all_objects.select_for_update().get(pk=intent.pk)
        if intent.status != PaymentIntent.Status.PENDING:
            # Already succeeded/failed/cancelled — edge case 9, an
            # idempotent no-op.
            WebhookEvent.objects.filter(pk=event.pk).update(
                processing_status=WebhookEvent.ProcessingStatus.IGNORED,
                processed_at=timezone.now(),
            )
            return

        business = intent.business
        business_share, commission_share = _split_commission(intent.amount)
        wallet_account = get_or_create_wallet_account(
            client=business.client, business=business, passenger=intent.passenger
        )
        clearing_account = get_or_create_business_clearing_account(
            client=business.client, business=business
        )
        commission_account = get_or_create_commission_account()
        entry = post_journal_entry(
            business=business,
            entry_type=JournalEntry.EntryType.PAYMENT,
            lines=[
                JournalLineInput(
                    account=wallet_account, amount=-intent.amount, currency=intent.currency
                ),
                JournalLineInput(
                    account=clearing_account, amount=business_share, currency=intent.currency
                ),
                JournalLineInput(
                    account=commission_account, amount=commission_share, currency=intent.currency
                ),
            ],
            external_reference=intent.psp_reference,
            memo=f"Payment for booking {intent.booking_id}",
        )
        intent.status = PaymentIntent.Status.SUCCEEDED
        intent.succeeded_at = timezone.now()
        intent.journal_entry = entry
        intent.save(update_fields=["status", "succeeded_at", "journal_entry"])

        booking = mark_booking_paid(booking=intent.booking)
        if booking.status != Booking.Status.PAID:
            # The booking's seat hold had already expired/been
            # cancelled by the time this webhook landed — edge case 6's
            # residual case. Real money moved (ADR-0006's own "keep our
            # own record regardless of what the PSP reports"); flagged
            # for manual attention rather than silently dropped.
            intent.requires_manual_refund = True
            intent.save(update_fields=["requires_manual_refund"])

    WebhookEvent.objects.filter(pk=event.pk).update(
        payment_intent=intent,
        processing_status=WebhookEvent.ProcessingStatus.PROCESSED,
        processed_at=timezone.now(),
    )
    record_audit_event(
        actor=None,
        action="payment.succeeded",
        target=intent,
        client_id=str(intent.client_id),
        amount=str(intent.amount),
    )


def _handle_charge_failed(*, event: WebhookEvent, reference: str) -> None:
    try:
        intent = PaymentIntent.all_objects.get(psp_reference=reference)
    except PaymentIntent.DoesNotExist:
        WebhookEvent.objects.filter(pk=event.pk).update(
            processing_status=WebhookEvent.ProcessingStatus.IGNORED, processed_at=timezone.now()
        )
        return

    WebhookEvent.objects.filter(pk=event.pk).update(client_id=intent.client_id)

    with transaction.atomic():
        intent = PaymentIntent.all_objects.select_for_update().get(pk=intent.pk)
        if intent.status != PaymentIntent.Status.PENDING:
            WebhookEvent.objects.filter(pk=event.pk).update(
                processing_status=WebhookEvent.ProcessingStatus.IGNORED,
                processed_at=timezone.now(),
            )
            return
        intent.status = PaymentIntent.Status.FAILED
        intent.failed_at = timezone.now()
        intent.save(update_fields=["status", "failed_at"])

    WebhookEvent.objects.filter(pk=event.pk).update(
        payment_intent=intent,
        processing_status=WebhookEvent.ProcessingStatus.PROCESSED,
        processed_at=timezone.now(),
    )
    record_audit_event(
        actor=None, action="payment.failed", target=intent, client_id=str(intent.client_id)
    )


def _handle_transfer_success(*, event: WebhookEvent, reference: str) -> None:
    """Phase 5 Slice 3. `reference` here is `SettlementRun.psp_transfer_reference`
    — a distinct reference namespace from `PaymentIntent.psp_reference`
    (`_handle_charge_success`'s own `reference`), both extracted by the
    same top-level `process_paystack_webhook` payload parsing. Called
    nested inside `process_paystack_webhook`'s already-open
    `platform_staff_bypass()` — the exact nesting shape the Slice 2
    re-entrant-bypass fix (`apps.core.rls`) was built for."""
    try:
        run = SettlementRun.all_objects.get(psp_transfer_reference=reference)
    except SettlementRun.DoesNotExist:
        WebhookEvent.objects.filter(pk=event.pk).update(
            processing_status=WebhookEvent.ProcessingStatus.IGNORED, processed_at=timezone.now()
        )
        return

    WebhookEvent.objects.filter(pk=event.pk).update(client_id=run.client_id)

    with transaction.atomic():
        run = SettlementRun.all_objects.select_for_update().get(pk=run.pk)
        if run.status != SettlementRun.Status.PROCESSING:
            # Already paid_out/failed, or a genuinely duplicate/
            # out-of-order delivery not already caught by
            # WebhookEvent's own dedup gate — idempotent no-op, same
            # shape as edge case 9.
            WebhookEvent.objects.filter(pk=event.pk).update(
                processing_status=WebhookEvent.ProcessingStatus.IGNORED,
                processed_at=timezone.now(),
            )
            return
        run.status = SettlementRun.Status.PAID_OUT
        run.executed_at = timezone.now()
        run.psp_transfer_status = "success"
        run.save(update_fields=["status", "executed_at", "psp_transfer_status"])

    WebhookEvent.objects.filter(pk=event.pk).update(
        processing_status=WebhookEvent.ProcessingStatus.PROCESSED, processed_at=timezone.now()
    )
    record_audit_event(
        actor=None, action="settlement_run.paid_out", target=run, client_id=str(run.client_id)
    )


def _handle_transfer_failed(*, event: WebhookEvent, reference: str) -> None:
    try:
        run = SettlementRun.all_objects.get(psp_transfer_reference=reference)
    except SettlementRun.DoesNotExist:
        WebhookEvent.objects.filter(pk=event.pk).update(
            processing_status=WebhookEvent.ProcessingStatus.IGNORED, processed_at=timezone.now()
        )
        return

    WebhookEvent.objects.filter(pk=event.pk).update(client_id=run.client_id)

    with transaction.atomic():
        run = SettlementRun.all_objects.select_for_update().get(pk=run.pk)
        if run.status != SettlementRun.Status.PROCESSING:
            WebhookEvent.objects.filter(pk=event.pk).update(
                processing_status=WebhookEvent.ProcessingStatus.IGNORED,
                processed_at=timezone.now(),
            )
            return
        run.status = SettlementRun.Status.FAILED
        run.psp_transfer_status = "failed"
        run.save(update_fields=["status", "psp_transfer_status"])

    WebhookEvent.objects.filter(pk=event.pk).update(
        processing_status=WebhookEvent.ProcessingStatus.PROCESSED, processed_at=timezone.now()
    )
    record_audit_event(
        actor=None, action="settlement_run.failed", target=run, client_id=str(run.client_id)
    )
