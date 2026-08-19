from django.db import models

from apps.core.models import BaseModel


class Business(BaseModel):
    """A Client can run multiple Businesses (e.g. two shuttle operations
    in two cities) — see docs/specs/1-identity-client-business.md §2.
    KYB review is independent of the owning Client's own KYC: a Business
    may exist and be reviewed while `Client.kyc_status` is still
    `pending` (§6). `kyb_status` will gate Route/Trip creation in
    Phase 3 — the field exists for that now, nothing enforces it yet.
    """

    class Vertical(models.TextChoices):
        SHUTTLE = "shuttle", "Shuttle"
        INTERCITY = "intercity", "Intercity"
        METRO = "metro", "Metro"

    class BookingMode(models.TextChoices):
        RESERVATION = "reservation", "Reservation"
        TAP_AND_GO = "tap_and_go", "Tap and go"

    class KybStatus(models.TextChoices):
        PENDING = "pending", "Pending"
        SUBMITTED = "submitted", "Submitted"
        APPROVED = "approved", "Approved"
        REJECTED = "rejected", "Rejected"

    class FarePricingMode(models.TextChoices):
        FLAT = "flat", "Flat"
        PER_SEGMENT = "per_segment", "Per segment"

    vertical = models.CharField(max_length=20, choices=Vertical.choices)
    name = models.CharField(max_length=255)
    # ASSUMPTION: no ISO-4217/IANA validation in Phase 1 — same treatment
    # Client.phone got in Slice 2.
    currency = models.CharField(max_length=8)
    timezone = models.CharField(max_length=64)
    booking_mode_default = models.CharField(max_length=20, choices=BookingMode.choices)
    is_active = models.BooleanField(default=True)
    # Phase 4 (docs/specs/4-fares-seating-booking.md §2): which of
    # apps.fares's two rule types applies to this Business's Routes,
    # selected at fare-lookup time, never stored per-Route. Client-admin
    # editable via the existing PATCH /businesses/{id}/ (business.manage)
    # — the operator's own pricing-model choice, same editability class
    # as booking_mode_default.
    fare_pricing_mode = models.CharField(
        max_length=20, choices=FarePricingMode.choices, default=FarePricingMode.FLAT
    )
    # Phase 4 Slice 2 (docs/adr/0004, docs/specs/4-fares-seating-booking.md
    # §2): how long a `seating.SeatReservation` stays `held` before the
    # Celery sweep task expires it. Deliberately NOT in BusinessSerializer's
    # writable fields — mutable only via the super-admin-only
    # PATCH /super-admin/businesses/{id}/seat-hold/ endpoint
    # (apps.businesses.views.BusinessSeatHoldView), so an operator can't
    # lengthen their own hold window against other operators' inventory
    # turnover. This is the one deliberate asymmetry with
    # fare_pricing_mode's client-editability just above.
    seat_hold_minutes = models.PositiveIntegerField(default=15)

    kyb_status = models.CharField(
        max_length=20, choices=KybStatus.choices, default=KybStatus.PENDING
    )
    kyb_submitted_at = models.DateTimeField(null=True, blank=True)
    kyb_decided_at = models.DateTimeField(null=True, blank=True)
    kyb_decided_by = models.ForeignKey(
        "identity.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    kyb_rejection_reason = models.TextField(blank=True)

    def __str__(self) -> str:
        return self.name


class KybDocument(BaseModel):
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

    # `client` (inherited from BaseModel) is what RLS/tenancy scopes on;
    # `business` narrows to which Business within that Client this
    # document is for. related_name="+" on both, deliberately — see
    # apps.clients.models.KycDocument's precedent and this slice's plan:
    # a reverse accessor on an RLS-protected model would go through the
    # same TenantScopedManager that silently empties for platform staff.
    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    document_type = models.CharField(max_length=40, choices=DocumentType.choices)
    file = models.FileField(upload_to="kyb-documents/%Y/%m/")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    reviewed_by = models.ForeignKey(
        "identity.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    rejection_reason = models.TextField(blank=True)

    def __str__(self) -> str:
        return f"{self.get_document_type_display()} ({self.business_id})"
