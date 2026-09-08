"""Fat-service layer for Business creation and KYB review — mirrors
apps.clients.services one-for-one (see docs/specs/1-identity-client-business.md
§10 step 3: "mirrors step 2's shape")."""

from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.clients.models import Client
from apps.core.audit import record_audit_event
from apps.identity.models import User
from apps.notifications.services import notify_kyb_submitted

from .models import Business, Director, KybDocument


def create_business(
    *,
    client: Client,
    vertical: str,
    name: str,
    currency: str,
    timezone_name: str,
    booking_mode_default: str,
    created_by: User,
    fare_pricing_mode: str = Business.FarePricingMode.FLAT,
    fare_collection_mode: str = Business.FareCollectionMode.PREPAID,
    seat_selection_enabled: bool = True,
    capacity_enforced: bool = True,
) -> Business:
    """Allowed regardless of the owning Client's own kyc_status (§6) —
    KYB review is independent of, and can proceed concurrently with, KYC.

    Every kwarg after `created_by` is optional and mirrors its model
    default, so call sites predating the phase that added it keep
    working unchanged — `fare_pricing_mode` from Phase 4
    (docs/specs/4-fares-seating-booking.md §2), the last three from
    docs/specs/10-booking-modes.md."""
    business = Business.objects.create(
        client=client,
        vertical=vertical,
        name=name,
        currency=currency,
        timezone=timezone_name,
        booking_mode_default=booking_mode_default,
        fare_pricing_mode=fare_pricing_mode,
        fare_collection_mode=fare_collection_mode,
        seat_selection_enabled=seat_selection_enabled,
        capacity_enforced=capacity_enforced,
    )
    record_audit_event(actor=created_by, action="business.created", target=business)
    return business


def update_business(*, business: Business, updated_by: User, **fields: Any) -> Business:
    """`fields` is whatever the serializer already validated — kyb_status
    and the kyb_* review fields are never writable here (§4: "not
    kyb_status — that's review-queue only"), enforced by the serializer
    never exposing them as writable, not by filtering here."""
    for field, value in fields.items():
        setattr(business, field, value)
    business.save(update_fields=list(fields))
    record_audit_event(actor=updated_by, action="business.updated", target=business, **fields)
    return business


def update_business_seat_hold_minutes(
    *, business: Business, seat_hold_minutes: int, updated_by: User
) -> Business:
    """Super-admin only — docs/adr/0004: an operator must not be able to
    lengthen their own hold window against other operators' inventory
    turnover, so this is deliberately its own function/endpoint, not
    part of update_business()'s general client-admin PATCH path."""
    business.seat_hold_minutes = seat_hold_minutes
    business.save(update_fields=["seat_hold_minutes"])
    record_audit_event(
        actor=updated_by,
        action="business.seat_hold_updated",
        target=business,
        seat_hold_minutes=seat_hold_minutes,
    )
    return business


def create_director(
    *, business: Business, full_name: str, id_type: str, id_number: str, created_by: User
) -> Director:
    """docs/specs/11-kyb-directors.md. Deliberately does not touch
    `kyb_status` — recording a director is not itself a submission;
    only uploading a document is (see submit_kyb_document below)."""
    director = Director.objects.create(
        client=business.client,
        business=business,
        full_name=full_name,
        id_type=id_type,
        id_number=id_number,
    )
    record_audit_event(actor=created_by, action="director.created", target=director)
    return director


def update_director(*, director: Director, updated_by: User, **fields: Any) -> Director:
    """`fields` is whatever the serializer already validated — same shape
    as update_business above, including `is_active` for soft-remove."""
    for field, value in fields.items():
        setattr(director, field, value)
    director.save(update_fields=list(fields))
    record_audit_event(
        actor=updated_by, action="director.updated", target=director, **fields
    )
    return director


def submit_kyb_document(
    *,
    business: Business,
    document_type: str,
    file: object,
    uploaded_by: User,
    director: Director | None = None,
) -> KybDocument:
    """Mirrors apps.clients.services.submit_kyc_document: any upload while
    kyb_status is pending or rejected moves it to submitted.

    `director` is optional and defaults to None so every pre-existing
    call site keeps working unchanged — set only for a director's ID
    document, null for company-level ones."""
    document = KybDocument.objects.create(
        client=business.client,
        business=business,
        director=director,
        document_type=document_type,
        file=file,
    )
    if business.kyb_status in (Business.KybStatus.PENDING, Business.KybStatus.REJECTED):
        business.kyb_status = Business.KybStatus.SUBMITTED
        business.kyb_submitted_at = timezone.now()
        business.save(update_fields=["kyb_status", "kyb_submitted_at"])
    record_audit_event(
        actor=uploaded_by,
        action="business.kyb_document_submitted",
        target=document,
        document_type=document_type,
    )
    notify_kyb_submitted(
        client_id=business.client_id, business_name=business.name, document_id=document.id
    )
    return document


def decide_business_kyb(
    *, business: Business, decision: str, reason: str, decided_by: User
) -> Business:
    """Mirrors apps.clients.services.decide_client_kyc, including
    select_for_update() for the same concurrent-decision reason (§7)."""
    with transaction.atomic():
        business = Business.all_objects.select_for_update().get(pk=business.pk)
        now = timezone.now()
        if decision == "approve":
            business.kyb_status = Business.KybStatus.APPROVED
            business.kyb_rejection_reason = ""
            document_status = KybDocument.Status.APPROVED
        else:
            business.kyb_status = Business.KybStatus.REJECTED
            business.kyb_rejection_reason = reason
            document_status = KybDocument.Status.REJECTED
        business.kyb_decided_at = now
        business.kyb_decided_by = decided_by
        business.save(
            update_fields=[
                "kyb_status",
                "kyb_rejection_reason",
                "kyb_decided_at",
                "kyb_decided_by",
            ]
        )
        # A decision on the business is a decision on the document bundle
        # that earned it — only the still-`pending` ones, so a document
        # from an earlier rejected round keeps recording that rejection
        # rather than being silently relabelled by a later approval.
        KybDocument.all_objects.filter(
            business=business, status=KybDocument.Status.PENDING
        ).update(
            status=document_status,
            reviewed_by=decided_by,
            reviewed_at=now,
            rejection_reason=reason if decision != "approve" else "",
        )
    record_audit_event(
        actor=decided_by,
        action="business.kyb_decided",
        target=business,
        decision=decision,
        reason=reason,
    )
    return business
