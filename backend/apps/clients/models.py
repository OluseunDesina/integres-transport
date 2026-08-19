import uuid

from django.db import models

from apps.core.models import BaseModel


class Client(models.Model):
    """Tenant root entity.

    Phase 0 was deliberately minimal — just enough to be the foreign-key
    target `apps.core.models.BaseModel`/`apps.identity.models.User`
    require for referential tenancy integrity (see docs/adr/0002). Phase 1
    Slice 2 adds the KYC fields additively, per the brief's zero-downtime
    migration discipline. Still no `client` FK on itself — it *is* the
    tenant, RLS does not apply to it (see docs/specs/1-identity-client-business.md §3).

    `email` is unique but nullable rather than the nullable-then-backfill
    two-step migration the spec proposed: Postgres `UNIQUE` already allows
    unlimited `NULL`s, so Phase 0's seed Client (created with no email)
    never collides with a real registered Client, without any backfill.
    """

    class KycStatus(models.TextChoices):
        PENDING = "pending", "Pending"
        SUBMITTED = "submitted", "Submitted"
        APPROVED = "approved", "Approved"
        REJECTED = "rejected", "Rejected"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    email = models.EmailField(unique=True, null=True, blank=True)
    # ASSUMPTION: no phone format validation in Phase 1 (E.164 or similar
    # could be added later without a migration — plain text for now).
    phone = models.CharField(max_length=32, blank=True)

    kyc_status = models.CharField(
        max_length=20, choices=KycStatus.choices, default=KycStatus.PENDING
    )
    kyc_submitted_at = models.DateTimeField(null=True, blank=True)
    kyc_decided_at = models.DateTimeField(null=True, blank=True)
    kyc_decided_by = models.ForeignKey(
        "identity.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    kyc_rejection_reason = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class KycDocument(BaseModel):
    class DocumentType(models.TextChoices):
        CERTIFICATE_OF_INCORPORATION = (
            "certificate_of_incorporation",
            "Certificate of incorporation",
        )
        PROOF_OF_ADDRESS = "proof_of_address", "Proof of address"
        DIRECTORS_ID = "directors_id", "Director's ID"
        TAX_CERTIFICATE = "tax_certificate", "Tax certificate"
        OTHER = "other", "Other"

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        APPROVED = "approved", "Approved"
        REJECTED = "rejected", "Rejected"

    document_type = models.CharField(max_length=40, choices=DocumentType.choices)
    file = models.FileField(upload_to="kyc-documents/%Y/%m/")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    reviewed_by = models.ForeignKey(
        "identity.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    rejection_reason = models.TextField(blank=True)

    def __str__(self) -> str:
        return f"{self.get_document_type_display()} ({self.client_id})"


class WhiteLabelConfig(BaseModel):
    """One-to-one with the owning Client — `BaseModel.client` already
    exists, so the "one-to-one" rule is a `UniqueConstraint` on it rather
    than redeclaring the field. RLS-protected like every other `BaseModel`
    subclass (see the registry test in `apps.core.tests.test_row_level_security`).

    `logo` is a `URLField`, not a `FileField`: this is branding
    configuration (a hosted logo URL a Client points at), not a document
    upload like `KycDocument`/`KybDocument`.
    """

    domain = models.CharField(max_length=255, unique=True)
    logo = models.URLField(blank=True)
    # ASSUMPTION: no hex-format validation in Phase 1 — same treatment
    # Client.phone got. Plain text, validated visually by whoever sets it.
    primary_color = models.CharField(max_length=32, blank=True)
    secondary_color = models.CharField(max_length=32, blank=True)
    email_sender_name = models.CharField(max_length=255, blank=True)
    email_sender_address = models.EmailField(blank=True)
    terms_url = models.URLField(blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["client"], name="unique_white_label_config_per_client"
            )
        ]

    def __str__(self) -> str:
        return self.domain


class ClientInvitation(models.Model):
    """Super-admin → prospective Client, distinct from
    `apps.identity.models.StaffInvitation`. Deliberately **not** a
    `BaseModel` subclass — no Client exists yet when this row is created,
    so there's nothing to scope it to and no RLS to apply (same reasoning
    as `apps.identity.models.Permission`). Its resolve/complete flow
    therefore needs no `platform_staff_bypass()` ceremony: the default
    manager already has no tenancy scoping at all.
    """

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        ACCEPTED = "accepted", "Accepted"
        REVOKED = "revoked", "Revoked"
        EXPIRED = "expired", "Expired"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    email = models.EmailField()
    token = models.CharField(max_length=64, unique=True)
    invited_by = models.ForeignKey(
        "identity.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    expires_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return f"{self.email} ({self.status})"
